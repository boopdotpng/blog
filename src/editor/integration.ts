// Dev-only blog editor. `astro dev` gets an /editor page plus a small file
// API under /__editor; `astro build` never sees either, so nothing here can
// ship to production.

import type { AstroIntegration } from 'astro';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const EXTS = ['md', 'mdx'] as const;
type Ext = (typeof EXTS)[number];

export default function blogEditor(): AstroIntegration {
  let root = process.cwd();
  return {
    name: 'blog-editor',
    hooks: {
      'astro:config:setup': ({ command, config, injectRoute, updateConfig }) => {
        if (command !== 'dev') return;
        root = fileURLToPath(config.root);
        injectRoute({ pattern: '/editor', entrypoint: './src/editor/EditorPage.astro' });
        // Pre-bundle up front: otherwise Vite discovers these on the first
        // visit and reloads the page mid-edit.
        updateConfig({
          vite: {
            optimizeDeps: {
              include: [
                'prosemirror-model', 'prosemirror-state', 'prosemirror-view', 'prosemirror-transform',
                'prosemirror-commands', 'prosemirror-keymap', 'prosemirror-history', 'prosemirror-inputrules',
                'prosemirror-schema-list', 'prosemirror-tables', 'prosemirror-gapcursor', 'prosemirror-dropcursor',
                'unified', 'remark-parse', 'remark-gfm', 'remark-math', 'remark-mdx', 'remark-stringify',
                'yaml', 'katex', 'shiki', 'preact', 'preact/hooks',
              ],
            },
          },
        });
      },
      'astro:server:setup': ({ server, logger }) => {
        server.middlewares.use('/__editor', createApi(root));
        logger.info('post editor at /editor');
      },
    },
  };
}

function createApi(root: string) {
  const blogDir = path.join(root, 'src/content/blog');
  const imageDir = path.join(root, 'public/images');
  const diagramDir = path.join(root, 'src/components/diagrams');

  const fileFor = (slug: string, ext: Ext) => path.join(blogDir, `${slug}.${ext}`);

  async function findPost(slug: string) {
    for (const ext of EXTS) {
      const file = fileFor(slug, ext);
      if (existsSync(file)) return { file, ext };
    }
    return null;
  }

  const routes: Record<string, (req: IncomingMessage, url: URL) => Promise<unknown>> = {
    'GET /posts': async () => {
      const files = (await readdir(blogDir)).filter((name) => /\.mdx?$/.test(name));
      return Promise.all(files.map(async (name) => {
        const file = path.join(blogDir, name);
        const source = await readFile(file, 'utf8');
        const field = (key: string) =>
          source.match(new RegExp(`^${key}:\\s*["']?(.*?)["']?\\s*$`, 'm'))?.[1];
        return {
          slug: name.replace(/\.mdx?$/, ''),
          ext: name.endsWith('.mdx') ? 'mdx' : 'md',
          title: field('title') ?? name,
          pubDate: field('pubDate') ?? '',
          published: field('published') !== 'false',
          cat: field('cat') ?? 'misc',
          mtime: (await stat(file)).mtimeMs,
        };
      }));
    },

    'GET /post': async (_req, url) => {
      const slug = requireSlug(url.searchParams.get('slug'));
      const post = await findPost(slug);
      if (!post) throw new HttpError(404, `no post named ${slug}`);
      return { slug, ext: post.ext, source: await readFile(post.file, 'utf8'), mtime: (await stat(post.file)).mtimeMs };
    },

    // Create, save, rename (slug change) and md <-> mdx conversion.
    'PUT /post': async (req) => {
      const body = JSON.parse(await readBody(req, 5_000_000).then(String));
      const slug = requireSlug(body.slug);
      const ext = requireExt(body.ext);
      const from = body.from ? requireSlug(body.from) : slug;
      if (typeof body.source !== 'string') throw new HttpError(400, 'missing source');

      const existing = await findPost(from);
      if (body.create && existing) throw new HttpError(409, `${from} already exists`);
      if (!body.create && !existing) throw new HttpError(404, `no post named ${from}`);
      if (existing && body.baseMtime != null && (await stat(existing.file)).mtimeMs !== body.baseMtime) {
        throw new HttpError(409, 'the file changed on disk since it was opened');
      }

      const target = fileFor(slug, ext);
      if (existing && existing.file !== target) {
        if ((await findPost(slug)) && slug !== from) throw new HttpError(409, `${slug} already exists`);
        await rename(existing.file, target);
      }
      await writeFile(target, body.source);
      return { slug, ext, mtime: (await stat(target)).mtimeMs };
    },

    // Raw image bytes in, public URL out.
    'POST /upload': async (req, url) => {
      const original = url.searchParams.get('name') ?? 'image.png';
      const parsed = path.parse(original.toLowerCase());
      const ext = /^\.(png|jpe?g|gif|webp|svg|avif)$/.test(parsed.ext) ? parsed.ext : '.png';
      const base = parsed.name.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'image';
      await mkdir(imageDir, { recursive: true });
      let name = `${base}${ext}`;
      for (let i = 2; existsSync(path.join(imageDir, name)); i++) name = `${base}-${i}${ext}`;
      await writeFile(path.join(imageDir, name), await readBody(req, 50_000_000));
      return { src: `/images/${name}` };
    },

    'GET /components': async () => {
      const files = existsSync(diagramDir) ? await readdir(diagramDir) : [];
      return files
        .filter((name) => /^[A-Z]\w*\.tsx$/.test(name))
        .map((name) => ({ name: name.replace(/\.tsx$/, ''), file: name }));
    },
  };

  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return next();
    // Any page open in the browser can reach localhost; only accept requests
    // from the editor itself (custom header => CORS preflight, plus origin check).
    const origin = req.headers.origin;
    if (req.headers['x-blog-editor'] !== '1' || (origin && new URL(origin).host !== req.headers.host)) {
      return send(res, 403, { error: 'editor requests only' });
    }
    try {
      send(res, 200, await route(req, url));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      send(res, status, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function requireSlug(value: unknown) {
  if (typeof value !== 'string' || !SLUG.test(value)) throw new HttpError(400, 'slugs are lowercase letters, digits and dashes');
  return value;
}

function requireExt(value: unknown): Ext {
  if (!EXTS.includes(value as Ext)) throw new HttpError(400, 'ext must be md or mdx');
  return value as Ext;
}

function readBody(req: IncomingMessage, limit: number) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}
