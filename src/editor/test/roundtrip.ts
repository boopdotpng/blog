// Round-trip every post through the editor model and check fidelity:
//   1. unchanged documents serialize byte-for-byte
//   2. forcing every block to re-stringify still renders the same HTML
// Run with: bun src/editor/test/roundtrip.ts
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkMdx from 'remark-mdx';
import { parseBody, serializeBody, splitFrontmatter } from '../client/markdown';

const dir = path.resolve('src/content/blog');
let failures = 0;

// Compare documents structurally, ignoring positions and formatting choices.
function normalize(source: string, mdx: boolean) {
  const p: any = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
  if (mdx) p.use(remarkMdx);
  const strip = (node: any): any => {
    const { position, data, spread, ...rest } = node;
    if (rest.children) rest.children = rest.children.map(strip);
    if (rest.type === 'list' && rest.start == null && !rest.ordered) delete rest.start;
    if (rest.attributes) rest.attributes = rest.attributes.map(({ position: _p, ...a }: any) =>
      a.value && typeof a.value === 'object' ? { ...a, value: a.value.value } : a);
    // <img .../> and <img ... /> are the same tag.
    if (rest.type === 'html') rest.value = rest.value.replace(/\s*\/?>$/, '>');
    return rest;
  };
  return JSON.stringify(strip(p.parse(source)));
}

for (const file of readdirSync(dir).filter((f) => /\.mdx?$/.test(f))) {
  const mdx = file.endsWith('.mdx');
  const source = readFileSync(path.join(dir, file), 'utf8');
  const { body } = splitFrontmatter(source);
  const { doc, origin } = parseBody(body, mdx);

  const preserved = serializeBody(doc, origin, mdx);
  const exact = preserved === body;

  const rewritten = serializeBody(doc, { ...origin, blocks: new WeakMap() }, mdx);
  const same = normalize(rewritten, mdx) === normalize(body, mdx);

  if (!exact || !same) failures++;
  console.log(`${exact ? 'ok  ' : 'DIFF'} ${same ? 'ok  ' : 'AST!'} ${file}`);
  if (!same && process.env.VERBOSE) {
    const a = body.split('\n'), b = rewritten.split('\n');
    let shown = 0;
    for (let i = 0; i < Math.max(a.length, b.length) && shown < 12; i++) {
      if (a[i] !== b[i]) { console.log(`  - ${a[i]}\n  + ${b[i]}`); shown++; }
    }
  }
}
process.exit(failures ? 1 : 0);
