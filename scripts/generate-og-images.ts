import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';

const BLOG_DIR = path.resolve('src/content/blog');
const FOLDERS_DIR = path.resolve('src/content/folders');
const OUT_DIR = path.resolve('public/og');
const WIDTH = 1200;
const HEIGHT = 630;

// Fetch a static-weight font satori can parse (Inter from Google Fonts CDN)
const fontRes = await fetch('https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfMZg.ttf');
const fontData = Buffer.from(await fontRes.arrayBuffer());

function parseFrontmatter(content: string) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) fm[key.trim()] = rest.join(':').trim().replace(/^["']|["']$/g, '');
  }
  return fm;
}

const catColors: Record<string, string> = {
  gpu: '#58a6ff',
  ml: '#d2a8ff',
  hardware: '#f0883e',
  bio: '#7ee787',
  misc: '#8b949e',
  code: '#79c0ff',
};

mkdirSync(OUT_DIR, { recursive: true });

const files = readdirSync(BLOG_DIR).filter(f => f.endsWith('.md'));

for (const file of files) {
  const slug = file.replace(/\.md$/, '');
  const content = readFileSync(path.join(BLOG_DIR, file), 'utf8');
  const fm = parseFrontmatter(content);

  if (fm.published === 'false') continue;

  const title = fm.title ?? slug;
  const cat = fm.cat ?? '';
  const catColor = catColors[cat] ?? '#8b949e';

  const svg = await satori(
    {
      type: 'div',
      props: {
        style: {
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '60px 80px',
          background: '#0d1117',
          fontFamily: 'Inter',
        },
        children: [
          cat && {
            type: 'div',
            props: {
              style: {
                color: catColor,
                fontSize: 22,
                letterSpacing: '0.08em',
                marginBottom: 20,
                textTransform: 'uppercase',
              },
              children: cat,
            },
          },
          {
            type: 'div',
            props: {
              style: {
                color: '#e6edf3',
                fontSize: title.length > 40 ? 48 : 56,
                fontWeight: 700,
                lineHeight: 1.2,
                letterSpacing: '-0.03em',
              },
              children: title,
            },
          },
          {
            type: 'div',
            props: {
              style: {
                color: '#484f58',
                fontSize: 20,
                marginTop: 'auto',
                display: 'flex',
                justifyContent: 'space-between',
              },
              children: [
                { type: 'span', props: { children: 'anuraagw.me' } },
                fm.pubDate ? { type: 'span', props: { children: fm.pubDate } } : null,
              ].filter(Boolean),
            },
          },
        ].filter(Boolean),
      },
    },
    {
      width: WIDTH,
      height: HEIGHT,
      fonts: [{ name: 'Inter', data: fontData, weight: 400, style: 'normal' as const }],
    },
  );

  const png = new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } }).render().asPng();
  writeFileSync(path.join(OUT_DIR, `${slug}.png`), png);
  console.log(`  ${slug}.png (${(png.length / 1024).toFixed(0)}KB)`);
}

// Generate OG images for folder documents
if (existsSync(FOLDERS_DIR)) {
  const folderIds = readdirSync(FOLDERS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const folderId of folderIds) {
    const folderDir = path.join(FOLDERS_DIR, folderId);
    const folderOutDir = path.join(OUT_DIR, 'folder', folderId);
    mkdirSync(folderOutDir, { recursive: true });
    const folderName = folderId.replace(/-/g, ' ');

    const docs = readdirSync(folderDir).filter(f => f.endsWith('.md'));
    for (const file of docs) {
      const slug = file.replace(/\.md$/, '');
      const content = readFileSync(path.join(folderDir, file), 'utf8');
      const fm = parseFrontmatter(content);

      if (fm.published === 'false') continue;

      const title = fm.title ?? slug;

      const svg = await satori(
        {
          type: 'div',
          props: {
            style: {
              width: '100%',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              padding: '60px 80px',
              background: '#0d1117',
              fontFamily: 'Inter',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    color: '#8b949e',
                    fontSize: 22,
                    letterSpacing: '0.08em',
                    marginBottom: 20,
                  },
                  children: `📁 ${folderName}`,
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    color: '#e6edf3',
                    fontSize: title.length > 40 ? 48 : 56,
                    fontWeight: 700,
                    lineHeight: 1.2,
                    letterSpacing: '-0.03em',
                  },
                  children: title,
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    color: '#484f58',
                    fontSize: 20,
                    marginTop: 'auto',
                    display: 'flex',
                    justifyContent: 'space-between',
                  },
                  children: [
                    { type: 'span', props: { children: 'anuraagw.me' } },
                    fm.pubDate ? { type: 'span', props: { children: fm.pubDate } } : null,
                  ].filter(Boolean),
                },
              },
            ],
          },
        },
        {
          width: WIDTH,
          height: HEIGHT,
          fonts: [{ name: 'Inter', data: fontData, weight: 400, style: 'normal' as const }],
        },
      );

      const png = new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } }).render().asPng();
      writeFileSync(path.join(folderOutDir, `${slug}.png`), png);
      console.log(`  folder/${folderId}/${slug}.png (${(png.length / 1024).toFixed(0)}KB)`);
    }
  }
}
