import { defineConfig } from 'astro/config';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import sitemap from '@astrojs/sitemap';
import fs from 'node:fs';
import path from 'node:path';
import remarkGallery from './scripts/remark-gallery.mjs';
import remarkCallout from './scripts/remark-callout.mjs';
import remarkSidenote from './scripts/remark-sidenote.mjs';
import remarkTableWrap from './scripts/remark-table-wrap.mjs';

function parseBlogFrontmatter(file) {
  const publishedMatch = file.match(/^\s*published:\s*["']?(true|false)["']?\s*$/m);
  const published = publishedMatch ? publishedMatch[1] === 'true' : true;

  const pubDateMatch = file.match(/^\s*pubDate:\s*["']?(\d{4}-\d{2}-\d{2})["']?\s*$/m);
  const pubDate = pubDateMatch ? pubDateMatch[1] : undefined;

  return { published, pubDate };
}

function getBlogMetadataByPathname() {
  const byPathname = new Map();
  const blogDir = path.resolve('src/content/blog');

  try {
    const entries = fs.readdirSync(blogDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md') && !entry.name.endsWith('.mdx')) continue;

      const slug = entry.name.replace(/\.(md|mdx)$/, '');
      const filePath = path.join(blogDir, entry.name);
      const file = fs.readFileSync(filePath, 'utf8');

      const { published, pubDate } = parseBlogFrontmatter(file);
      const pathname = `/blog/${slug}`;
      byPathname.set(pathname, { published, pubDate });
    }
  } catch {
    // Best-effort only; sitemap generation still works without per-post lastmod.
  }

  return byPathname;
}

function getBooksMetadataByPathname() {
  const byPathname = new Map();
  const booksDir = path.resolve('src/content/books');

  try {
    const bookEntries = fs.readdirSync(booksDir, { withFileTypes: true });
    for (const bookEntry of bookEntries) {
      if (!bookEntry.isDirectory()) continue;

      const bookId = bookEntry.name;
      const bookPath = path.join(booksDir, bookId);
      const fileEntries = fs.readdirSync(bookPath, { withFileTypes: true });

      const bookPathname = `/book/${bookId}`;
      byPathname.set(bookPathname, { published: true, pubDate: undefined });

      // Add individual chapters
      for (const fileEntry of fileEntries) {
        if (!fileEntry.isFile()) continue;
        if (!fileEntry.name.endsWith('.md') && !fileEntry.name.endsWith('.mdx')) continue;

        const slug = fileEntry.name.replace(/\.(md|mdx)$/, '');
        const filePath = path.join(bookPath, fileEntry.name);
        const file = fs.readFileSync(filePath, 'utf8');

        const { published, pubDate } = parseBlogFrontmatter(file);
        const chapterPathname = `/book/${bookId}/${slug}`;
        byPathname.set(chapterPathname, { published, pubDate });
      }
    }
  } catch {
    // Best-effort only; sitemap generation still works without per-post lastmod.
  }

  return byPathname;
}

const BLOG_METADATA_BY_PATHNAME = getBlogMetadataByPathname();
const BOOKS_METADATA_BY_PATHNAME = getBooksMetadataByPathname();

export default defineConfig({
  site: process.env.SITE_URL ?? 'https://anuraagw.me',
  trailingSlash: 'never',
  build: { format: 'file' },
  integrations: [
    sitemap({
      filter: (page) => {
        const pathname = new URL(page).pathname;
        // Don't include non-canonical or non-content routes in the sitemap.
        if (pathname === '/rss.xml' || pathname === '/404' || pathname === '/404.html') return false;

        const normalizedPathname = pathname.replace(/\/$/, '') || '/';
        const blogMeta = BLOG_METADATA_BY_PATHNAME.get(normalizedPathname);
        const booksMeta = BOOKS_METADATA_BY_PATHNAME.get(normalizedPathname);

        if (blogMeta && !blogMeta.published) return false;
        if (booksMeta && !booksMeta.published) return false;

        return true;
      },
      serialize: (item) => {
        const pathname = new URL(item.url).pathname.replace(/\/$/, '') || '/';
        const blogMeta = BLOG_METADATA_BY_PATHNAME.get(pathname);
        const booksMeta = BOOKS_METADATA_BY_PATHNAME.get(pathname);

        const getLastmod = (meta) => {
          if (!meta?.pubDate) return undefined;
          const lastmod = new Date(`${meta.pubDate}T00:00:00.000Z`);
          return Number.isNaN(lastmod.getTime()) ? undefined : lastmod.toISOString();
        };

        const blogLastmod = getLastmod(blogMeta);
        const booksLastmod = getLastmod(booksMeta);
        const lastmod = blogLastmod || booksLastmod;

        if (lastmod) {
          return { ...item, lastmod, changefreq: 'monthly', priority: 0.7 };
        }

        if (pathname === '/') {
          return { ...item, changefreq: 'weekly', priority: 1.0 };
        }

        if (pathname.startsWith('/book/')) {
          return { ...item, changefreq: 'weekly', priority: 0.6 };
        }

        return { ...item, changefreq: 'monthly', priority: 0.5 };
      },
    }),
  ],
  markdown: {
    remarkPlugins: [remarkMath, remarkGallery, remarkCallout, remarkSidenote, remarkTableWrap],
    rehypePlugins: [rehypeKatex],
    shikiConfig: {
      themes: {
        light: 'github-light',
        dark: 'github-dark-dimmed',
      },
      defaultColor: false,
    },
  },
});
