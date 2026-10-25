// Markdown/MDX <-> ProseMirror conversion.
//
// Parsing uses the same remark extensions as the site (GFM, math, MDX) plus
// the ((sidenote)) syntax. Serializing is source-preserving: every top-level
// block remembers the exact text it was parsed from, and ProseMirror keeps
// untouched nodes by identity, so only blocks you actually edited are
// re-stringified. Opening and saving a post without edits is a no-op diff.

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkMdx from 'remark-mdx';
import remarkStringify from 'remark-stringify';
import { Fragment, Slice, type Mark, type Node as PMNode } from 'prosemirror-model';
import { schema } from './schema';

// mdast nodes, loosely typed: the conversion switches on `type` anyway.
type Md = { type: string; children?: Md[]; value?: string; position?: any; [key: string]: any };

const nodes = schema.nodes;
const markTypes = schema.marks;

function sidenoteHandler(node: Md, _parent: unknown, state: any, info: any) {
  const tracker = state.createTracker(info);
  let value = tracker.move('((');
  value += tracker.move(state.containerPhrasing(node, { before: value, after: ')', ...tracker.current() }));
  value += tracker.move('))');
  return value;
}

// Matches how the posts are already written.
const stringifyOptions = {
  bullet: '-',
  emphasis: '*',
  strong: '*',
  fence: '`',
  fences: true,
  rule: '-',
  listItemIndent: 'one',
  incrementListMarker: true,
  handlers: { sidenote: sidenoteHandler },
} as const;

function processor(mdx: boolean) {
  const p: any = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
  if (mdx) p.use(remarkMdx);
  return p.use(remarkStringify, stringifyOptions);
}

const processors = { md: processor(false), mdx: processor(true) };

// ── frontmatter ─────────────────────────────────────────────

export function splitFrontmatter(source: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) return { head: '', yaml: null as string | null, body: source };
  return { head: match[0], yaml: match[1], body: source.slice(match[0].length) };
}

// ── sidenotes ───────────────────────────────────────────────
// Mirrors scripts/remark-sidenote.mjs, but yields a `sidenote` mdast node.

function transformSidenotes(node: Md) {
  if (!Array.isArray(node.children) || node.type === 'sidenote') return;
  const children = node.children;

  for (let start = 0; start < children.length; start++) {
    const first = children[start];
    if (first.type !== 'text') continue;
    const open = first.value!.indexOf('((');
    if (open === -1) continue;

    let end = start;
    let close = -1;
    for (; end < children.length; end++) {
      const candidate = children[end];
      if (candidate.type !== 'text') continue;
      close = candidate.value!.indexOf('))', end === start ? open + 2 : 0);
      if (close !== -1) break;
    }
    if (close === -1) continue;

    const last = children[end];
    const noteChildren = end === start
      ? [text(first.value!.slice(open + 2, close))]
      : [text(first.value!.slice(open + 2)), ...children.slice(start + 1, end), text(last.value!.slice(0, close))];
    const replacement = [
      text(first.value!.slice(0, open)),
      { type: 'sidenote', children: noteChildren },
      text(last.value!.slice(close + 2)),
    ];
    children.splice(start, end - start + 1, ...replacement);
    start += replacement.length - 2;
  }

  for (const child of children) transformSidenotes(child);
}

function text(value: string): Md {
  return { type: 'text', value };
}

// ── images ──────────────────────────────────────────────────

const IMAGE_ATTRS = new Set(['src', 'alt', 'title', 'width']);

// Only plain <img> tags become image nodes; anything fancier stays raw.
export function parseImgTag(html: string) {
  const match = /^<img\b([^>]*?)\/?>\s*$/i.exec(html.trim());
  if (!match) return null;
  const attrs: Record<string, string> = {};
  const rest = match[1].replace(/([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_, name, dq, sq) => {
    attrs[name.toLowerCase()] = dq ?? sq;
    return '';
  });
  if (rest.trim() || !attrs.src || Object.keys(attrs).some((key) => !IMAGE_ATTRS.has(key))) return null;
  return attrs;
}

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

export function imgTag(attrs: { src: string; alt?: string; title?: string | null; width?: string | null }) {
  let tag = `<img src="${escapeAttr(attrs.src)}" alt="${escapeAttr(attrs.alt ?? '')}"`;
  if (attrs.title) tag += ` title="${escapeAttr(attrs.title)}"`;
  if (attrs.width) tag += ` width="${escapeAttr(String(attrs.width))}"`;
  return `${tag} />`;
}

// ── mdast -> ProseMirror ────────────────────────────────────

interface OriginBlock { seq: number; text: string; gapAfter: string }

export interface Origin {
  blocks: WeakMap<PMNode, OriginBlock>;
  // Text before the first block (MDX imports live here) and after the last.
  preamble: string;
  trailing: string;
  esm: string[];
}

interface Ctx { src: string; mdx: boolean }

const slice = (node: Md, ctx: Ctx) =>
  node.position ? ctx.src.slice(node.position.start.offset, node.position.end.offset) : '';

function addMark(marks: readonly Mark[], mark: Mark) {
  return mark.addToSet(marks);
}

function inlineToPM(children: Md[] = [], marks: readonly Mark[], ctx: Ctx): PMNode[] {
  const out: PMNode[] = [];
  for (const child of children) {
    switch (child.type) {
      case 'text':
        if (child.value) out.push(schema.text(child.value, marks));
        break;
      case 'emphasis':
        out.push(...inlineToPM(child.children, addMark(marks, markTypes.em.create()), ctx));
        break;
      case 'strong':
        out.push(...inlineToPM(child.children, addMark(marks, markTypes.strong.create()), ctx));
        break;
      case 'delete':
        out.push(...inlineToPM(child.children, addMark(marks, markTypes.strike.create()), ctx));
        break;
      case 'link':
        out.push(...inlineToPM(child.children, addMark(marks, markTypes.link.create({ href: child.url, title: child.title ?? null })), ctx));
        break;
      case 'inlineCode':
        if (child.value) out.push(schema.text(child.value, addMark(marks, markTypes.code.create())));
        else out.push(nodes.raw_inline.create({ source: slice(child, ctx) }, null, marks));
        break;
      case 'break':
        out.push(nodes.hard_break.create(null, null, marks));
        break;
      case 'inlineMath':
        out.push(nodes.math_inline.create({ tex: child.value }, null, marks));
        break;
      case 'sidenote':
        out.push(nodes.sidenote.create(null, inlineToPM(child.children, [], ctx).filter((n) => nodes.sidenote.contentMatch.matchType(n.type) || n.isText), marks));
        break;
      case 'html':
        out.push(nodes.raw_inline.create({ source: child.value }, null, marks));
        break;
      default:
        // image, linkReference, footnoteReference, inline JSX, {expressions}...
        out.push(nodes.raw_inline.create({ source: slice(child, ctx) }, null, marks));
    }
  }
  return out;
}

function jsxImageAttrs(node: Md) {
  const attrs: Record<string, string> = {};
  for (const attr of node.attributes ?? []) {
    if (attr.type !== 'mdxJsxAttribute' || typeof attr.value !== 'string' || !IMAGE_ATTRS.has(attr.name)) return null;
    attrs[attr.name] = attr.value;
  }
  return attrs.src && !node.children?.length ? attrs : null;
}

function imageNode(attrs: Record<string, string>, syntax: string) {
  return nodes.image.create({ src: attrs.src, alt: attrs.alt ?? '', title: attrs.title ?? null, width: attrs.width ?? null, syntax });
}

function blockToPM(node: Md, ctx: Ctx): PMNode[] {
  switch (node.type) {
    case 'paragraph': {
      const parts = (node.children ?? []).filter((c) => !(c.type === 'text' && !c.value!.trim()));
      if (parts.length === 1 && parts[0].type === 'image') {
        return [imageNode({ src: parts[0].url, alt: parts[0].alt ?? '', title: parts[0].title ?? undefined } as any, 'md')];
      }
      if (parts.length === 1 && parts[0].type === 'html') {
        const img = parseImgTag(parts[0].value!);
        if (img) return [imageNode(img, 'html')];
      }
      return [nodes.paragraph.create(null, inlineToPM(node.children, [], ctx))];
    }
    case 'heading':
      return [nodes.heading.create({ level: node.depth }, inlineToPM(node.children, [], ctx))];
    case 'thematicBreak':
      return [nodes.horizontal_rule.create()];
    case 'blockquote': {
      const content = blocksToPM(node.children, ctx);
      return [nodes.blockquote.create(null, content.length ? content : [nodes.paragraph.create()])];
    }
    case 'list': {
      const items = (node.children ?? []).map((item) => {
        const content = blocksToPM(item.children, ctx);
        return nodes.list_item.create(
          { spread: !!item.spread, checked: item.checked ?? null },
          content.length ? content : [nodes.paragraph.create()],
        );
      });
      return [node.ordered
        ? nodes.ordered_list.create({ start: node.start ?? 1, spread: !!node.spread }, items)
        : nodes.bullet_list.create({ spread: !!node.spread }, items)];
    }
    case 'code':
      return [nodes.code_block.create(
        { lang: node.lang ?? '', meta: node.meta ?? null },
        node.value ? schema.text(node.value) : null,
      )];
    case 'math':
      return [nodes.math_block.create({ tex: node.value ?? '' })];
    case 'html': {
      const img = parseImgTag(node.value!);
      return [img ? imageNode(img, 'html') : nodes.raw_block.create({ source: node.value })];
    }
    case 'table': {
      const align: (string | null)[] = node.align ?? [];
      const rows = (node.children ?? []).map((row, rowIndex) =>
        nodes.table_row.create(null, (row.children ?? []).map((cell, cellIndex) =>
          (rowIndex === 0 ? nodes.table_header : nodes.table_cell).create(
            { align: align[cellIndex] ?? null },
            inlineToPM(cell.children, [], ctx),
          ),
        )),
      );
      return [nodes.table.create(null, rows)];
    }
    case 'mdxJsxFlowElement': {
      const name: string = node.name ?? '';
      if (/^[A-Z]/.test(name)) return [nodes.component.create({ source: slice(node, ctx), name })];
      const img = name === 'img' ? jsxImageAttrs(node) : null;
      if (img) return [imageNode(img, 'jsx')];
      return [nodes.raw_block.create({ source: slice(node, ctx) })];
    }
    default:
      // definitions, footnoteDefinition, {expressions}, anything new.
      return [nodes.raw_block.create({ source: slice(node, ctx) })];
  }
}

function blocksToPM(children: Md[] = [], ctx: Ctx) {
  return children.flatMap((child) => blockToPM(child, ctx));
}

function parseTree(body: string, mdx: boolean): Md {
  const tree = processors[mdx ? 'mdx' : 'md'].parse(body);
  transformSidenotes(tree);
  return tree;
}

const VOID_TAGS = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function balanced(html: string, tag: string) {
  if (VOID_TAGS.has(tag.toLowerCase())) return true;
  const count = (re: RegExp) => html.match(re)?.length ?? 0;
  const selfClosing = count(new RegExp(`<${tag}\\b[^>]*/>`, 'gi'));
  return count(new RegExp(`<${tag}\\b`, 'gi')) - selfClosing <= count(new RegExp(`</${tag}\\s*>`, 'gi'));
}

export function parseBody(body: string, mdx: boolean): { doc: PMNode; origin: Origin } {
  const ctx: Ctx = { src: body, mdx };
  const tree = parseTree(body, mdx);
  const blocks = new WeakMap<PMNode, OriginBlock>();
  const esm: string[] = [];
  const content: PMNode[] = [];
  let preambleEnd = -1;
  let lastEnd = 0;
  let previous: OriginBlock | null = null;
  let seq = 0;

  const children = tree.children ?? [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const start = child.position.start.offset;
    let end = child.position.end.offset;
    if (child.type === 'mdxjsEsm') {
      esm.push(slice(child, ctx));
      lastEnd = end;
      continue;
    }
    if (preambleEnd === -1) preambleEnd = start;
    if (previous) previous.gapAfter = body.slice(lastEnd, start);

    // HTML containing blank lines (e.g. inline <svg>) parses as several
    // blocks; keep everything up to the closing tag as one raw block.
    let converted: PMNode[];
    const tag = child.type === 'html' ? /^<([a-zA-Z][\w-]*)/.exec(child.value!)?.[1] : undefined;
    if (tag && !balanced(child.value!, tag)) {
      let j = i;
      while (j + 1 < children.length && !balanced(body.slice(start, end), tag)) end = children[++j].position.end.offset;
      i = j;
      converted = [nodes.raw_block.create({ source: body.slice(start, end) })];
    } else {
      converted = blockToPM(child, ctx);
    }
    const record: OriginBlock = { seq: seq++, text: body.slice(start, end), gapAfter: '\n\n' };
    // A block that maps to a single node can be written back verbatim.
    if (converted.length === 1) blocks.set(converted[0], record);
    content.push(...converted);
    previous = record;
    lastEnd = end;
  }

  if (!content.length) content.push(nodes.paragraph.create());
  return {
    doc: nodes.doc.create(null, content),
    origin: {
      blocks,
      esm,
      // A blank body keeps its spacing after the frontmatter and gains a
      // final newline once there's content.
      preamble: preambleEnd === -1 ? body || '\n' : body.slice(0, preambleEnd),
      trailing: preambleEnd === -1 ? '\n' : body.slice(lastEnd),
    },
  };
}

// ── ProseMirror -> mdast ────────────────────────────────────

function markToMd(mark: Mark): Md {
  switch (mark.type.name) {
    case 'link': return { type: 'link', url: mark.attrs.href, title: mark.attrs.title ?? null, children: [] };
    case 'strong': return { type: 'strong', children: [] };
    case 'em': return { type: 'emphasis', children: [] };
    default: return { type: 'delete', children: [] };
  }
}

function leafToMd(node: PMNode): Md {
  switch (node.type.name) {
    case 'text':
      return node.marks.some((m) => m.type === markTypes.code)
        ? { type: 'inlineCode', value: node.text }
        : { type: 'text', value: node.text };
    case 'hard_break': return { type: 'break' };
    case 'math_inline': return { type: 'inlineMath', value: node.attrs.tex };
    case 'sidenote': return { type: 'sidenote', children: inlineToMd(node) };
    default: return { type: 'html', value: node.attrs.source ?? '' };
  }
}

const ATTENTION = new Set(['strong', 'emphasis', 'delete']);

// `**foo **` isn't emphasis in Markdown; move edge whitespace outside.
function hoistWhitespace(children: Md[]): Md[] {
  const out: Md[] = [];
  for (const child of children) {
    if (!child.children || !ATTENTION.has(child.type)) {
      if (child.children) child.children = hoistWhitespace(child.children);
      out.push(child);
      continue;
    }
    child.children = hoistWhitespace(child.children);
    let before = '';
    let after = '';
    const first = child.children[0];
    if (first?.type === 'text') {
      const trimmed = first.value!.replace(/^\s+/, '');
      before = first.value!.slice(0, first.value!.length - trimmed.length);
      first.value = trimmed;
    }
    const last = child.children[child.children.length - 1];
    if (last?.type === 'text') {
      const trimmed = last.value!.replace(/\s+$/, '');
      after = last.value!.slice(trimmed.length);
      last.value = trimmed;
    }
    child.children = child.children.filter((c) => c.type !== 'text' || c.value);
    if (before) out.push(text(before));
    if (child.children.length) out.push(child);
    if (after) out.push(text(after));
  }
  return out;
}

function inlineToMd(parent: PMNode): Md[] {
  const root: Md[] = [];
  const stack: { mark: Mark; node: Md }[] = [];
  parent.forEach((child) => {
    const marks = child.marks.filter((m) => m.type !== markTypes.code);
    let keep = 0;
    while (keep < stack.length && keep < marks.length && stack[keep].mark.eq(marks[keep])) keep++;
    stack.length = keep;
    for (let i = keep; i < marks.length; i++) {
      const md = markToMd(marks[i]);
      (stack.length ? stack[stack.length - 1].node.children! : root).push(md);
      stack.push({ mark: marks[i], node: md });
    }
    (stack.length ? stack[stack.length - 1].node.children! : root).push(leafToMd(child));
  });
  return hoistWhitespace(root);
}

// Leading/trailing spaces in a paragraph mean nothing in Markdown, but
// remark would encode them as &#x20;.
function trimEdges(children: Md[]) {
  const first = children[0];
  if (first?.type === 'text') first.value = first.value!.replace(/^\s+/, '');
  const last = children[children.length - 1];
  if (last?.type === 'text') last.value = last.value!.replace(/\s+$/, '');
  return children.filter((child) => child.type !== 'text' || child.value);
}

function blockToMd(node: PMNode): Md {
  const children = (n: PMNode) => {
    const out: Md[] = [];
    n.forEach((child) => out.push(blockToMd(child)));
    return out;
  };
  switch (node.type.name) {
    case 'paragraph': return { type: 'paragraph', children: trimEdges(inlineToMd(node)) };
    case 'heading': return { type: 'heading', depth: node.attrs.level, children: trimEdges(inlineToMd(node)) };
    case 'blockquote': return { type: 'blockquote', children: children(node) };
    case 'horizontal_rule': return { type: 'thematicBreak' };
    case 'code_block': return { type: 'code', lang: node.attrs.lang || null, meta: node.attrs.meta, value: node.textContent };
    case 'bullet_list':
    case 'ordered_list':
      return {
        type: 'list',
        ordered: node.type.name === 'ordered_list',
        start: node.attrs.start ?? null,
        spread: node.attrs.spread,
        children: children(node),
      };
    case 'list_item': return { type: 'listItem', spread: node.attrs.spread, checked: node.attrs.checked, children: children(node) };
    case 'math_block': return { type: 'math', value: node.attrs.tex };
    case 'image':
      return node.attrs.syntax === 'md'
        ? { type: 'paragraph', children: [{ type: 'image', url: node.attrs.src, alt: node.attrs.alt, title: node.attrs.title }] }
        : { type: 'html', value: imgTag(node.attrs as any) };
    case 'table': {
      const align: (string | null)[] = [];
      node.firstChild?.forEach((cell) => align.push(cell.attrs.align));
      const rows: Md[] = [];
      node.forEach((row) => {
        const cells: Md[] = [];
        row.forEach((cell) => cells.push({ type: 'tableCell', children: inlineToMd(cell) }));
        rows.push({ type: 'tableRow', children: cells });
      });
      return { type: 'table', align, children: rows };
    }
    default:
      return { type: 'html', value: node.attrs.source ?? '' };
  }
}

// remark-stringify escapes conservatively (`\~`, `snake\_case`). Drop any
// class of escapes whose removal leaves the parsed document unchanged.
const ESCAPABLE = ['~', '_', '*', '#', '+', '-', '.', '!', '[', ']', '(', ')', '<', '>', '|', '$', '&', '`'];

function astKey(markdown: string, mdx: boolean) {
  const strip = (node: Md): Md => {
    const { position, data, ...rest } = node;
    if (rest.children) rest.children = rest.children.map(strip);
    if (rest.attributes) rest.attributes = rest.attributes.map(({ position: _p, value, ...a }: Md) => ({ ...a, value: (value as any)?.value ?? value }));
    return rest;
  };
  try {
    return JSON.stringify(strip(processors[mdx ? 'mdx' : 'md'].parse(markdown)));
  } catch {
    return null; // e.g. an MDX syntax error: never prefer this candidate
  }
}

function minimizeEscapes(markdown: string, mdx: boolean) {
  if (!markdown.includes('\\')) return markdown;
  const target = astKey(markdown, mdx);
  let out = markdown;
  for (const ch of ESCAPABLE) {
    if (!out.includes(`\\${ch}`)) continue;
    const candidate = out.split(`\\${ch}`).join(ch);
    if (astKey(candidate, mdx) === target) out = candidate;
  }
  return out;
}

const stringified = new WeakMap<PMNode, string>();

function stringifyBlocks(blocks: Md[], mdx: boolean) {
  const markdown = processors[mdx ? 'mdx' : 'md'].stringify({ type: 'root', children: blocks }).replace(/\n+$/, '');
  return minimizeEscapes(markdown, mdx);
}

// Edited blocks are re-stringified on every save; nodes are immutable, so
// cache by identity.
function stringifyNode(node: PMNode, mdx: boolean) {
  const key = `${mdx}`;
  const cached = stringified.get(node);
  if (cached?.startsWith(key)) return cached.slice(key.length);
  const markdown = stringifyBlocks([blockToMd(node)], mdx);
  stringified.set(node, key + markdown);
  return markdown;
}

export function serializeBody(doc: PMNode, origin: Origin | null, mdx: boolean, imports: string[] = []) {
  let out = '';
  let previous: OriginBlock | undefined;
  let written = 0;
  doc.forEach((node) => {
    const record = origin?.blocks.get(node);
    // Empty paragraphs are just places to put the cursor.
    if (!record && node.type === nodes.paragraph && !node.content.size) return;
    if (written++) out += previous && record && record.seq === previous.seq + 1 ? previous.gapAfter : '\n\n';
    out += record ? record.text : stringifyNode(node, mdx);
    previous = record;
  });

  let preamble = origin?.preamble ?? '';
  if (mdx) {
    const esm = origin?.esm ?? [];
    const imported = (line: string) => {
      const name = /^import\s+(\w+)/.exec(line)?.[1];
      return esm.some((existing) => new RegExp(`\\bimport\\s+${name}\\b`).test(existing));
    };
    const missing = imports.filter((line) => !imported(line));
    if (!esm.length && !missing.length) {
      // Nothing to import; keep whatever led the body.
    } else if (!esm.length) {
      preamble = `${missing.join('\n')}\n\n${preamble.trimStart()}`;
    } else if (missing.length) {
      // Append new imports right after the existing ones.
      const lastImport = esm[esm.length - 1];
      const at = preamble.indexOf(lastImport) + lastImport.length;
      preamble = `${preamble.slice(0, at)}\n${missing.join('\n')}${preamble.slice(at)}`;
    }
  }

  return preamble + out + (out ? origin?.trailing ?? '\n' : '');
}

// ── clipboard ───────────────────────────────────────────────

export function markdownToSlice(markdown: string, mdx: boolean): Slice {
  const { doc } = parseBody(markdown, mdx);
  return Slice.maxOpen(doc.content);
}

export function fragmentToMarkdown(fragment: Fragment, mdx: boolean) {
  const blocks: Md[] = [];
  let inline = false;
  fragment.forEach((node) => {
    if (node.isInline) inline = true;
    else blocks.push(blockToMd(node));
  });
  if (inline) return stringifyBlocks([{ type: 'paragraph', children: inlineToMd(nodes.paragraph.create(null, fragment)) }], mdx);
  return stringifyBlocks(blocks, mdx);
}

// ── misc ────────────────────────────────────────────────────

export function documentStats(doc: PMNode) {
  let words = 0;
  let math = false;
  const components = new Set<string>();
  doc.descendants((node) => {
    if (node.isText) words += node.text!.split(/\s+/).filter(Boolean).length;
    if (node.type === nodes.math_block || node.type === nodes.math_inline) math = true;
    if (node.type === nodes.component) components.add(node.attrs.name);
    return true;
  });
  return { words, math, components };
}

// <NocGrid client:visible src={[16, 11]} /> -> { name, props } for live previews.
// Expressions are evaluated: this only ever runs on your own posts in dev.
export function parseComponent(source: string) {
  const tree = processors.mdx.parse(source) as Md;
  const element = tree.children?.find((node) => node.type === 'mdxJsxFlowElement');
  if (!element) return null;
  const props: Record<string, unknown> = {};
  for (const attr of element.attributes ?? []) {
    if (attr.type !== 'mdxJsxAttribute' || attr.name.includes(':')) continue;
    if (attr.value == null) props[attr.name] = true;
    else if (typeof attr.value === 'string') props[attr.name] = attr.value;
    else props[attr.name] = new Function(`return (${attr.value.value});`)();
  }
  return { name: element.name as string, props };
}
