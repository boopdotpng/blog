import { access, copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const distDir = path.resolve('dist');
  const site = process.env.SITE_URL ?? 'https://anuraagw.me';

  const sitemapIndex = path.join(distDir, 'sitemap-index.xml');
  const sitemapZero = path.join(distDir, 'sitemap-0.xml');
  const sitemap = path.join(distDir, 'sitemap.xml');

  if (await fileExists(sitemapIndex)) {
    await copyFile(sitemapIndex, sitemap);
  } else if (await fileExists(sitemapZero)) {
    await copyFile(sitemapZero, sitemap);
  } else {
    throw new Error(
      `No sitemap found in dist (expected sitemap-index.xml or sitemap-0.xml). Did the build run @astrojs/sitemap?`,
    );
  }

  const robotsPath = path.join(distDir, 'robots.txt');
  if (await fileExists(robotsPath)) {
    const robots = await readFile(robotsPath, 'utf8');
    const sitemapLine = `Sitemap: ${site.replace(/\/$/, '')}/sitemap.xml`;

    const next =
      robots.match(/^Sitemap:/m)
        ? robots.replace(/^Sitemap:.*$/m, sitemapLine)
        : `${robots.trimEnd()}\n\n${sitemapLine}\n`;

    await writeFile(robotsPath, next);
  }
}

await main();
