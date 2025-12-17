import { defineConfig } from 'astro/config';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import sitemap from '@astrojs/sitemap';
import fs from 'node:fs';
import path from 'node:path';
import remarkGallery from './scripts/remark-gallery.mjs';

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

const BLOG_METADATA_BY_PATHNAME = getBlogMetadataByPathname();

export default defineConfig({
  site: process.env.SITE_URL ?? 'https://anuraagw.me',
  trailingSlash: 'never',
  integrations: [
    sitemap({
      filter: (page) => {
        const pathname = new URL(page).pathname;
        // Don't include non-canonical or non-content routes in the sitemap.
        if (pathname === '/rss.xml' || pathname === '/404' || pathname === '/404.html') return false;

        const normalizedPathname = pathname.replace(/\/$/, '') || '/';
        const blogMeta = BLOG_METADATA_BY_PATHNAME.get(normalizedPathname);
        if (blogMeta && !blogMeta.published) return false;

        return true;
      },
      serialize: (item) => {
        const pathname = new URL(item.url).pathname.replace(/\/$/, '') || '/';
        const blogMeta = BLOG_METADATA_BY_PATHNAME.get(pathname);
        const blogLastmod = (() => {
          if (!blogMeta?.pubDate) return undefined;
          const lastmod = new Date(`${blogMeta.pubDate}T00:00:00.000Z`);
          return Number.isNaN(lastmod.getTime()) ? undefined : lastmod.toISOString();
        })();

        if (blogLastmod) {
          return { ...item, lastmod: blogLastmod, changefreq: 'monthly', priority: 0.7 };
        }

        if (pathname === '/') {
          return { ...item, changefreq: 'weekly', priority: 1.0 };
        }

        return { ...item, changefreq: 'monthly', priority: 0.5 };
      },
    }),
  ],
  markdown: {
    remarkPlugins: [remarkMath, remarkGallery],
    rehypePlugins: [rehypeKatex],
  },
});
