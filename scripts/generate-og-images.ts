import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';

const BLOG_DIR = path.resolve('src/content/blog');
const BOOKS_DIR = path.resolve('src/content/books');
const OUT_DIR = path.resolve('public/og');
const WIDTH = 1200;
const HEIGHT = 630;

// Brand font (the family the site renders in). The self-hosted copy is a
// variable font satori's parser can't read, so we pull static TTF instances
// of the exact same family from Google Fonts.
async function loadFont(family: string, weight: number) {
  const api = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}`;
  const css = await (await fetch(api, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
  const url = css.match(/src:\s*url\((https:[^)]+\.ttf)\)/)?.[1];
  if (!url) throw new Error(`no static TTF for ${family} ${weight}`);
  return Buffer.from(await (await fetch(url)).arrayBuffer());
}

const [fontRegular, fontBold] = await Promise.all([
  loadFont('Google Sans Code', 400),
  loadFont('Google Sans Code', 700),
]);

// Warm-paper palette, mirroring the site's light theme.
const PAPER = '#faf9f7';
const INK = '#1a1a1a';
const INK_SOFT = '#37352f';
const FAINT = '#8c867b';
const ACCENT = '#4a7c96';

// Category colours from the site's --cat-* tokens (light theme).
const catColors: Record<string, string> = {
  gpu: '#3a8a6e',
  ml: '#c06a20',
  hardware: '#b85a8a',
  tenstorrent: '#3e8db0',
  bio: '#7c6ab8',
  misc: '#7a8694',
  code: '#4a7c96',
};

// add alpha to a #rrggbb hex
const alpha = (hex: string, a: number) => {
  const n = Math.round(Math.max(0, Math.min(1, a)) * 255);
  return hex + n.toString(16).padStart(2, '0');
};

/**
 * Decorative tile grid that bleeds off the right edge — a nod to the NoC
 * routing diagrams. Most tiles sit faint; an L-shaped "route" lights up in
 * the category colour, just like a packet hop on the real grid.
 */
function tileGrid(color: string) {
  const COLS = 16;
  const ROWS = 21;
  const TILE = 24;
  const GAP = 6;

  // dimension-ordered route: along a row, then down a column
  const lit = new Set<number>();
  const ry = 4;
  const cx = 9;
  for (let c = 1; c <= cx; c++) lit.add(ry * COLS + c);
  for (let r = ry; r <= 16; r++) lit.add(r * COLS + cx);

  const tiles = [];
  for (let i = 0; i < COLS * ROWS; i++) {
    const on = lit.has(i);
    tiles.push({
      type: 'div',
      props: {
        style: {
          width: TILE,
          height: TILE,
          margin: GAP / 2,
          borderRadius: 4,
          background: on ? alpha(color, 0.82) : alpha(color, 0.1),
        },
      },
    });
  }

  return {
    type: 'div',
    props: {
      style: {
        position: 'absolute',
        top: -18,
        right: -46,
        width: COLS * (TILE + GAP),
        display: 'flex',
        flexWrap: 'wrap',
      },
      children: tiles,
    },
  };
}

function card(opts: { tag: string; tagColor: string; title: string; date?: string }) {
  const { tag, tagColor, title, date } = opts;
  const titleSize = title.length > 52 ? 44 : title.length > 34 ? 52 : 60;

  return {
    type: 'div',
    props: {
      style: {
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'flex',
        background: PAPER,
        fontFamily: 'Google Sans Code',
        overflow: 'hidden',
      },
      children: [
        // soft category-tinted glow, top-right
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute',
              inset: 0,
              backgroundImage: `radial-gradient(circle at 82% 12%, ${alpha(tagColor, 0.22)}, ${alpha(PAPER, 0)} 58%)`,
            },
          },
        },
        // tile-grid motif on the right
        tileGrid(tagColor),
        // paper veil so the left text column stays clean
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute',
              inset: 0,
              backgroundImage: `linear-gradient(to right, ${PAPER} 34%, ${alpha(PAPER, 0.45)} 58%, ${alpha(PAPER, 0)} 78%)`,
            },
          },
        },
        // accent hairline down the left edge
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: 8,
              background: tagColor,
            },
          },
        },
        // content
        {
          type: 'div',
          props: {
            style: {
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              padding: '64px 80px',
              width: 760,
              height: '100%',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    color: tagColor,
                    fontSize: 22,
                    fontWeight: 600,
                    letterSpacing: '0.16em',
                    textTransform: 'uppercase',
                    marginBottom: 26,
                  },
                  children: tag,
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    color: INK,
                    fontSize: titleSize,
                    fontWeight: 700,
                    lineHeight: 1.18,
                    letterSpacing: '-0.02em',
                  },
                  children: title,
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginTop: 'auto',
                    fontSize: 20,
                  },
                  children: [
                    { type: 'span', props: { style: { color: INK_SOFT, fontWeight: 600 }, children: 'anuraagw.me' } },
                    date
                      ? { type: 'span', props: { style: { color: FAINT }, children: date } }
                      : null,
                  ].filter(Boolean),
                },
              },
            ],
          },
        },
      ],
    },
  };
}

const fonts = [
  { name: 'Google Sans Code', data: fontRegular, weight: 400 as const, style: 'normal' as const },
  { name: 'Google Sans Code', data: fontBold, weight: 700 as const, style: 'normal' as const },
];

async function renderPng(node: Parameters<typeof satori>[0]) {
  const svg = await satori(node, { width: WIDTH, height: HEIGHT, fonts });
  return new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } }).render().asPng();
}

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

mkdirSync(OUT_DIR, { recursive: true });

const files = readdirSync(BLOG_DIR).filter(f => f.endsWith('.md') || f.endsWith('.mdx'));

for (const file of files) {
  const slug = file.replace(/\.mdx?$/, '');
  const content = readFileSync(path.join(BLOG_DIR, file), 'utf8');
  const fm = parseFrontmatter(content);

  if (fm.published === 'false') continue;

  const title = fm.title ?? slug;
  const cat = fm.cat ?? '';
  const tagColor = catColors[cat] ?? ACCENT;

  const png = await renderPng(
    card({ tag: cat || 'writing', tagColor, title, date: fm.pubDate }),
  );
  writeFileSync(path.join(OUT_DIR, `${slug}.png`), png);
  console.log(`  ${slug}.png (${(png.length / 1024).toFixed(0)}KB)`);
}

// Generate OG images for book chapters
if (existsSync(BOOKS_DIR)) {
  const bookIds = readdirSync(BOOKS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const bookId of bookIds) {
    const bookDir = path.join(BOOKS_DIR, bookId);
    const bookOutDir = path.join(OUT_DIR, 'book', bookId);
    mkdirSync(bookOutDir, { recursive: true });
    const bookName = bookId.replace(/-/g, ' ');

    const docs = readdirSync(bookDir).filter(f => f.endsWith('.md') || f.endsWith('.mdx'));
    for (const file of docs) {
      const slug = file.replace(/\.mdx?$/, '');
      const content = readFileSync(path.join(bookDir, file), 'utf8');
      const fm = parseFrontmatter(content);

      if (fm.published === 'false') continue;

      const title = fm.title ?? slug;

      const png = await renderPng(
        card({ tag: `book · ${bookName}`, tagColor: ACCENT, title, date: fm.pubDate }),
      );
      writeFileSync(path.join(bookOutDir, `${slug}.png`), png);
      console.log(`  book/${bookId}/${slug}.png (${(png.length / 1024).toFixed(0)}KB)`);
    }
  }
}
