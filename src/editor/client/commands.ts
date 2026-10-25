import { Fragment, type MarkType, type Node as PMNode, type ResolvedPos } from 'prosemirror-model';
import { NodeSelection, Selection, TextSelection, type Command, type EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { setBlockType, wrapIn, lift } from 'prosemirror-commands';
import { wrapInList, liftListItem } from 'prosemirror-schema-list';
import { CALLOUTS } from './decorations';
import { pickFiles, sidenoteViewAt, type EditorContext } from './nodeviews';
import { schema } from './schema';

const { nodes, marks } = schema;

export function markActive(state: EditorState, type: MarkType) {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

export function blockActive(state: EditorState, type: PMNode['type'], attrs?: Record<string, unknown>) {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type === type && (!attrs || Object.entries(attrs).every(([k, v]) => node.attrs[k] === v))) return true;
  }
  return false;
}

// The contiguous range around $pos carrying a mark of `type`.
export function markExtent($pos: ResolvedPos, type: MarkType) {
  const parent = $pos.parent;
  const start = $pos.start();
  let mark = type.isInSet($pos.marks());
  if (!mark && $pos.nodeAfter) mark = type.isInSet($pos.nodeAfter.marks);
  if (!mark) return null;
  let from = -1;
  let to = -1;
  let offset = 0;
  let found = false;
  parent.forEach((child) => {
    const childFrom = start + offset;
    const childTo = childFrom + child.nodeSize;
    offset += child.nodeSize;
    if (found) return;
    if (mark!.isInSet(child.marks)) {
      if (from === -1) from = childFrom;
      to = childTo;
      if (childFrom <= $pos.pos && $pos.pos <= childTo) found = true;
    } else if (from !== -1 && !(childFrom <= $pos.pos && $pos.pos <= childTo)) {
      from = to = -1;
    }
  });
  return from === -1 ? null : { from, to, mark };
}

// Selected inline content within one textblock, filtered to what fits.
function selectedInline(state: EditorState, allowed: (node: PMNode) => boolean) {
  const { $from, $to, empty } = state.selection;
  if (empty || !$from.sameParent($to) || !$from.parent.inlineContent) return Fragment.empty;
  const content: PMNode[] = [];
  $from.parent.slice($from.parentOffset, $to.parentOffset).content.forEach((node) => {
    if (allowed(node)) content.push(node);
  });
  return Fragment.from(content);
}

export function insertSidenote(view: EditorView) {
  const { state } = view;
  const { from, to, $from } = state.selection;
  if ($from.parent.type.spec.code || !$from.parent.inlineContent) return false;
  const content = selectedInline(state, (node) => node.isText || nodes.sidenote.contentMatch.matchType(node.type) != null);
  view.dispatch(state.tr.replaceWith(from, to, nodes.sidenote.create(null, content)).scrollIntoView());
  sidenoteViewAt(view, from)?.focus();
  return true;
}

export function insertMathInline(view: EditorView) {
  const { state } = view;
  const { from, to, $from } = state.selection;
  if ($from.parent.type.spec.code || !$from.parent.inlineContent) return false;
  const tex = state.doc.textBetween(from, to);
  const tr = state.tr.replaceWith(from, to, nodes.math_inline.create({ tex }));
  view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, from)));
  return true;
}

// Insert a block at the cursor: replaces the current block when it's an
// empty paragraph, otherwise goes after it. Atoms get selected (which opens
// their editor); other blocks get the cursor.
export function insertBlock(view: EditorView, node: PMNode) {
  const { state } = view;
  const { $from } = state.selection;
  let tr = state.tr;
  let pos: number;
  const parent = $from.parent;
  if (state.selection instanceof NodeSelection) {
    pos = state.selection.to;
    tr = tr.insert(pos, node);
  } else if (parent.isTextblock && !parent.content.size && $from.depth >= 1) {
    pos = $from.before();
    tr = tr.replaceWith(pos, $from.after(), node);
  } else {
    pos = $from.after(1);
    tr = tr.insert(pos, node);
  }
  // Always leave somewhere to keep typing.
  if (!tr.doc.resolve(pos + node.nodeSize).nodeAfter) tr = tr.insert(pos + node.nodeSize, nodes.paragraph.create());
  const selection = node.isAtom ? NodeSelection.create(tr.doc, pos) : Selection.near(tr.doc.resolve(pos + 1));
  view.dispatch(tr.setSelection(selection).scrollIntoView());
  view.focus();
  return true;
}

export function insertTable(view: EditorView, rows = 3, cols = 3) {
  const cell = (header: boolean) => (header ? nodes.table_header : nodes.table_cell).create();
  const table = nodes.table.create(null, Array.from({ length: rows }, (_, r) =>
    nodes.table_row.create(null, Array.from({ length: cols }, () => cell(r === 0)))));
  return insertBlock(view, table);
}

export function setCallout(view: EditorView, type: string) {
  const callout = CALLOUTS.find((c) => c.type === type)!;
  const label = `${callout.label} `;
  const { state } = view;
  const { $from } = state.selection;
  if (!blockActive(state, nodes.blockquote)) {
    if ($from.parent.type === nodes.paragraph && !$from.parent.content.size) {
      const pos = $from.before();
      const tr = state.tr.replaceWith(pos, $from.after(), nodes.blockquote.create(null, nodes.paragraph.create(null, schema.text(label))));
      view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 2 + label.length)).scrollIntoView());
      view.focus();
      return true;
    }
    if (!wrapIn(nodes.blockquote)(state, view.dispatch)) return false;
  }
  // Replace any existing label on the quote's first line.
  const next = view.state;
  const $pos = next.selection.$from;
  let depth = $pos.depth;
  while (depth > 0 && $pos.node(depth).type !== nodes.blockquote) depth--;
  const quoteStart = $pos.start(depth);
  const first = next.doc.resolve(quoteStart + 1);
  const text = first.parent.textContent;
  const existing = CALLOUTS.map((c) => c.re.exec(text)).find(Boolean);
  const start = first.start();
  const length = existing ? existing[0].length + (text[existing[0].length] === ' ' ? 1 : 0) : 0;
  view.dispatch(next.tr.insertText(label, start, start + length));
  view.focus();
  return true;
}

export async function insertImages(view: EditorView, ctx: EditorContext, files: File[], at?: number) {
  const images = files.filter((file) => file.type.startsWith('image/'));
  if (!images.length) return;
  if (at != null) view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(at))));
  for (const file of images) {
    const src = await ctx.upload(file);
    insertBlock(view, nodes.image.create({ src, alt: '', syntax: 'html' }));
  }
  // Nudge for alt text straight away.
  requestAnimationFrame(() => {
    const { selection } = view.state;
    if (selection instanceof NodeSelection) (view.nodeDOM(selection.from) as HTMLElement | null)?.querySelector<HTMLInputElement>('.pm-image-alt')?.focus();
  });
}

export async function pickImages(view: EditorView, ctx: EditorContext) {
  await insertImages(view, ctx, await pickFiles(true));
}

export async function insertGallery(view: EditorView, ctx: EditorContext) {
  const files = await pickFiles(true);
  const lines = [];
  for (const file of files) lines.push(`${await ctx.upload(file)} | `);
  const text = lines.join('\n') || '/images/example.png | caption';
  insertBlock(view, nodes.code_block.create({ lang: 'gallery' }, schema.text(text)));
}

export function insertComponent(view: EditorView, name: string) {
  return insertBlock(view, nodes.component.create({ name, source: `<${name} client:visible />` }));
}

export const setParagraph: Command = setBlockType(nodes.paragraph);
export const setHeading = (level: number): Command => setBlockType(nodes.heading, { level });
export const bulletList: Command = wrapInList(nodes.bullet_list);
export const orderedList: Command = wrapInList(nodes.ordered_list);
export const quote: Command = (state, dispatch) =>
  blockActive(state, nodes.blockquote) ? lift(state, dispatch) : wrapIn(nodes.blockquote)(state, dispatch);

// Toggle a list: lift out if already inside one of that type.
export function toggleList(type: PMNode['type']): Command {
  return (state, dispatch) => {
    if (blockActive(state, type)) return liftListItem(nodes.list_item)(state, dispatch);
    return wrapInList(type)(state, dispatch);
  };
}

export { marks, nodes };
