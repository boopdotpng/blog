import { defineConfig } from 'astro/config';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import sitemap from '@astrojs/sitemap';
import fs from 'node:fs';
import path from 'node:path';
import remarkGallery from './scripts/remark-gallery.mjs';

function getBlogLastmodByPathname() {
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

      const match = file.match(/^\s*pubDate:\s*["']?(\d{4}-\d{2}-\d{2})["']?\s*$/m);
      if (!match) continue;

      const isoDate = match[1];
      const lastmod = new Date(`${isoDate}T00:00:00.000Z`);
      if (Number.isNaN(lastmod.getTime())) continue;

      byPathname.set(`/blog/${slug}`, lastmod.toISOString());
    }
  } catch {
    // Best-effort only; sitemap generation still works without per-post lastmod.
  }

  return byPathname;
}

const BLOG_LASTMOD_BY_PATHNAME = getBlogLastmodByPathname();

export default defineConfig({
  site: process.env.SITE_URL ?? 'https://anuraagw.me',
  trailingSlash: 'never',
  integrations: [
    sitemap({
      filter: (page) => {
        const pathname = new URL(page).pathname;
        // Don't include non-canonical or non-content routes in the sitemap.
        return pathname !== '/rss.xml' && pathname !== '/404' && pathname !== '/404.html';
      },
      serialize: (item) => {
        const pathname = new URL(item.url).pathname.replace(/\/$/, '') || '/';
        const blogLastmod = BLOG_LASTMOD_BY_PATHNAME.get(pathname);

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
