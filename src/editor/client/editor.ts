import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-gapcursor/style/gapcursor.css';
import 'prosemirror-tables/style/tables.css';

import { EditorState, NodeSelection, Plugin, Selection, TextSelection, type Command, type Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Fragment, Slice, type MarkType, type Node as PMNode, type NodeType } from 'prosemirror-model';
import { baseKeymap, chainCommands, exitCode, toggleMark } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { InputRule, inputRules, textblockTypeInputRule, undoInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { goToNextCell, tableEditing, addRowAfter, addColumnAfter, deleteRow, deleteColumn } from 'prosemirror-tables';
import { caret } from './caret';
import {
  bulletList, insertBlock, insertComponent, insertGallery, insertImages, insertMathInline, insertSidenote,
  insertTable, nodes, orderedList, pickImages, quote, setCallout, setHeading, setParagraph,
} from './commands';
import { calloutPlugin, highlightPlugin, placeholderPlugin } from './decorations';
import { fragmentToMarkdown, markdownToSlice } from './markdown';
import { bubblePlugin, editLink, slashPlugin, type SlashItem } from './menus';
import { createNodeViews, sidenoteViewAt, type EditorContext } from './nodeviews';
import { schema } from './schema';

// ── input rules ─────────────────────────────────────────────

// (prefix)(delimited content) at the end of the typed text. The prefix is
// context that must not be consumed (e.g. a space before *emphasis*).
function markRule(re: RegExp, type: MarkType, open: number, attrs?: (match: RegExpMatchArray) => Record<string, unknown>) {
  return new InputRule(re, (state, match, start, end) => {
    const [, prefix = '', content] = match;
    const from = start + prefix.length;
    const contentStart = from + open;
    const contentEnd = contentStart + content.length;
    const tr = state.tr.delete(contentEnd, end).delete(from, contentStart);
    tr.addMark(from, from + content.length, type.create(attrs?.(match)));
    tr.removeStoredMark(type);
    return tr;
  });
}

function inlineRules() {
  const { marks: m } = schema;
  return [
    markRule(/()(?:\*\*|__)([^*_\s](?:[^*_]*[^*_\s])?)(?:\*\*|_)$/, m.strong, 2),
    markRule(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*$/, m.em, 1),
    markRule(/(^|[^_\w])_([^_\s](?:[^_]*[^_\s])?)_$/, m.em, 1),
    markRule(/()`([^`]+)`$/, m.code, 1),
    markRule(/()~~([^~]+)~~$/, m.strike, 2),
    markRule(/()\[([^\]]+)\]\(([^)\s]+)\)$/, m.link, 1, (match) => ({ href: match[3] })),
    // $tex$ -> inline math (a space before the closing $ keeps it as text,
    // so "$5 and $10" stays prose).
    new InputRule(/(^|[^$\\\w])\$([^$\s](?:[^$]*[^$\s])?)\$$/, (state, match, start, end) => {
      const from = start + match[1].length;
      return state.tr.replaceWith(from, end, nodes.math_inline.create({ tex: match[2] }));
    }),
  ];
}

function blockRules() {
  return [
    textblockTypeInputRule(/^(#{1,6})\s$/, nodes.heading, (match) => ({ level: match[1].length })),
    wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
    wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list),
    wrappingInputRule(/^(\d+)\.\s$/, nodes.ordered_list, (match) => ({ start: Number(match[1]) }),
      (match, node) => node.childCount + node.attrs.start === Number(match[1])),
    textblockTypeInputRule(/^```([\w+#-]*)\s$/, nodes.code_block, (match) => ({ lang: match[1] })),
    blockReplaceRule(/^---$/, () => nodes.horizontal_rule.create()),
    blockReplaceRule(/^\$\$\s$/, () => nodes.math_block.create()),
  ];
}

// Replace a whole paragraph (e.g. "---") with a block.
function blockReplaceRule(re: RegExp, create: () => PMNode) {
  return new InputRule(re, (state, _match, start) => {
    const $start = state.doc.resolve(start);
    if ($start.parent.type !== nodes.paragraph || $start.depth < 1) return null;
    const node = create();
    const tr = state.tr.replaceWith($start.before(), $start.after(), [node, nodes.paragraph.create()]);
    const pos = $start.before();
    return tr.setSelection(node.isAtom && node.type !== nodes.horizontal_rule
      ? NodeSelection.create(tr.doc, pos)
      : TextSelection.create(tr.doc, pos + node.nodeSize + 1));
  });
}

// ── keymap ──────────────────────────────────────────────────

const inCode = (state: EditorState) => state.selection.$from.parent.type.spec.code;

// Enter in a paragraph reading ```lang or $$ turns it into that block.
const fenceEnter: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type !== nodes.paragraph || $from.parentOffset !== $from.parent.content.size) return false;
  const text = $from.parent.textContent;
  const fence = /^```([\w+#-]*)$/.exec(text);
  if (fence) {
    if (dispatch) {
      const tr = state.tr.replaceWith($from.before(), $from.after(), nodes.code_block.create({ lang: fence[1] }));
      dispatch(tr.setSelection(TextSelection.create(tr.doc, $from.before() + 1)).scrollIntoView());
    }
    return true;
  }
  if (text === '$$') {
    if (dispatch) {
      const tr = state.tr.replaceWith($from.before(), $from.after(), [nodes.math_block.create(), nodes.paragraph.create()]);
      dispatch(tr.setSelection(NodeSelection.create(tr.doc, $from.before())));
    }
    return true;
  }
  return false;
};

// Two blank lines at the end of a code block exit it.
const codeEnter: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.type.spec.code || $from.parentOffset !== $from.parent.content.size) return false;
  if (!$from.parent.textContent.endsWith('\n\n')) return false;
  if (dispatch) {
    const tr = state.tr.delete($from.pos - 2, $from.pos);
    const after = tr.mapping.map($from.after());
    tr.insert(after, nodes.paragraph.create());
    dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView());
  }
  return true;
};

const codeIndent: Command = (state, dispatch) => {
  if (!inCode(state)) return false;
  dispatch?.(state.tr.insertText('  ').scrollIntoView());
  return true;
};

const codeDedent: Command = (state, dispatch) => {
  if (!inCode(state)) return false;
  const { $from } = state.selection;
  const text = $from.parent.textContent;
  const lineStart = text.lastIndexOf('\n', $from.parentOffset - 1) + 1;
  const spaces = /^ {1,2}/.exec(text.slice(lineStart))?.[0].length ?? 0;
  if (spaces) dispatch?.(state.tr.delete($from.start() + lineStart, $from.start() + lineStart + spaces));
  return true;
};

// Backspace at the start of a heading/code block makes it a paragraph.
const resetBlockAtStart: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false;
  const parent = $from.parent;
  if (parent.type === nodes.paragraph || !parent.isTextblock) return false;
  if (parent.type === nodes.code_block && parent.content.size) return false;
  return setParagraph(state, dispatch);
};

const liftListAtStart: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0 || $from.depth < 2) return false;
  if ($from.node(-1).type !== nodes.list_item || $from.index(-1) !== 0) return false;
  return liftListItem(nodes.list_item)(state, dispatch);
};

const hardBreak: Command = (state, dispatch) => {
  if (inCode(state)) return false;
  dispatch?.(state.tr.replaceSelectionWith(nodes.hard_break.create()).scrollIntoView());
  return true;
};

const viewCommand = (run: (view: EditorView) => unknown): Command => (_state, _dispatch, view) => {
  if (!view) return false;
  run(view);
  return true;
};

// ── setup ───────────────────────────────────────────────────

export interface EditorOptions {
  mount: HTMLElement;
  doc: PMNode;
  mdx: () => boolean;
  ctx: EditorContext;
  components: () => string[];
  onChange: (view: EditorView, tr: Transaction) => void;
  onSave: () => void;
  onToggleSource: () => void;
}

export function slashItems(view: () => EditorView, opts: EditorOptions): SlashItem[] {
  const cmd = (command: Command) => (v: EditorView) => command(v.state, v.dispatch, v);
  const items: SlashItem[] = [
    { section: 'text', title: 'text', keywords: 'paragraph plain', hint: '⌘⌥0', run: cmd(setParagraph) },
    { section: 'text', title: 'heading 1', keywords: 'h1 title', hint: '#', run: cmd(setHeading(1)) },
    { section: 'text', title: 'heading 2', keywords: 'h2 section', hint: '##', run: cmd(setHeading(2)) },
    { section: 'text', title: 'heading 3', keywords: 'h3 subsection', hint: '###', run: cmd(setHeading(3)) },
    { section: 'text', title: 'bullet list', keywords: 'ul unordered', hint: '-', run: cmd(bulletList) },
    { section: 'text', title: 'numbered list', keywords: 'ol ordered', hint: '1.', run: cmd(orderedList) },
    { section: 'text', title: 'quote', keywords: 'blockquote', hint: '>', run: cmd(quote) },
    { section: 'notes', title: 'sidenote', keywords: 'footnote margin aside', hint: '((', run: insertSidenote },
    { section: 'notes', title: 'callout: note', keywords: 'admonition', hint: '> Note:', run: (v) => setCallout(v, 'note') },
    { section: 'notes', title: 'callout: tl;dr', keywords: 'admonition summary tldr', hint: '> tl;dr:', run: (v) => setCallout(v, 'tldr') },
    { section: 'notes', title: 'callout: update', keywords: 'admonition edit', hint: '> Update:', run: (v) => setCallout(v, 'update') },
    { section: 'notes', title: 'callout: warning', keywords: 'admonition caution', hint: '> Warning:', run: (v) => setCallout(v, 'warning') },
    { section: 'blocks', title: 'code block', keywords: 'pre snippet fence', hint: '```', run: (v) => insertBlock(v, nodes.code_block.create()) },
    { section: 'blocks', title: 'math block', keywords: 'equation katex latex display', hint: '$$', run: (v) => insertBlock(v, nodes.math_block.create()) },
    { section: 'blocks', title: 'inline math', keywords: 'equation katex latex', hint: '$x$', run: insertMathInline },
    { section: 'blocks', title: 'table', keywords: 'grid', run: (v) => insertTable(v) },
    { section: 'blocks', title: 'divider', keywords: 'hr rule line separator', hint: '---', run: (v) => insertBlock(v, nodes.horizontal_rule.create()) },
    { section: 'media', title: 'image', keywords: 'picture photo upload img', run: (v) => pickImages(v, opts.ctx) },
    { section: 'media', title: 'gallery', keywords: 'images carousel photos', run: (v) => insertGallery(v, opts.ctx) },
    { section: 'media', title: 'html block', keywords: 'raw svg embed', run: (v) => insertBlock(v, nodes.raw_block.create({ source: '' })) },
  ];
  if (opts.mdx()) {
    for (const name of opts.components()) {
      items.push({ section: 'diagrams', title: name, keywords: 'component diagram mdx interactive', run: (v) => insertComponent(v, name) });
    }
  }
  return items;
}

export function createEditor(opts: EditorOptions) {
  let view: EditorView;

  const markKeys = {
    'Mod-b': toggleMark(schema.marks.strong),
    'Mod-i': toggleMark(schema.marks.em),
    'Mod-e': toggleMark(schema.marks.code),
    'Mod-Shift-x': toggleMark(schema.marks.strike),
    'Mod-k': viewCommand(editLink),
    'Mod-Alt-m': viewCommand(insertMathInline),
  };

  // Shared with nested sidenote editors.
  opts.ctx.innerPlugins = () => [caret.plugin(), inputRules({ rules: inlineRules() }), keymap(markKeys)];

  const plugins: Plugin[] = [
    slashPlugin(() => slashItems(() => view, opts)),
    inputRules({ rules: [...inlineRules(), ...blockRules()] }),
    keymap({
      ...markKeys,
      'Mod-z': undo,
      'Shift-Mod-z': redo,
      'Mod-y': redo,
      'Mod-s': () => (opts.onSave(), true),
      'Mod-/': () => (opts.onToggleSource(), true),
      'Mod-Alt-n': viewCommand(insertSidenote),
      'Mod-Alt-0': setParagraph,
      'Mod-Alt-1': setHeading(1),
      'Mod-Alt-2': setHeading(2),
      'Mod-Alt-3': setHeading(3),
      'Mod-Shift-8': bulletList,
      'Mod-Shift-7': orderedList,
      'Mod-Shift-.': quote,
      Enter: chainCommands(codeEnter, fenceEnter, splitListItem(nodes.list_item)),
      'Shift-Enter': chainCommands(exitCode, hardBreak),
      Tab: chainCommands(goToNextCell(1), sinkListItem(nodes.list_item), codeIndent),
      'Shift-Tab': chainCommands(goToNextCell(-1), liftListItem(nodes.list_item), codeDedent),
      Backspace: chainCommands(undoInputRule, resetBlockAtStart, liftListAtStart),
      'Mod-ArrowUp': (state, dispatch) => (dispatch?.(state.tr.setSelection(Selection.atStart(state.doc)).scrollIntoView()), true),
      'Mod-ArrowDown': (state, dispatch) => (dispatch?.(state.tr.setSelection(Selection.atEnd(state.doc)).scrollIntoView()), true),
      'Mod-Alt-ArrowDown': addRowAfter,
      'Mod-Alt-ArrowRight': addColumnAfter,
      'Mod-Alt-Backspace': chainCommands(deleteRow, deleteColumn),
    }),
    keymap(baseKeymap),
    history(),
    dropCursor({ color: 'var(--accent)', width: 2 }),
    gapCursor(),
    tableEditing(),
    caret.plugin(),
    calloutPlugin,
    placeholderPlugin,
    highlightPlugin(),
    bubblePlugin(),
  ];

  view = new EditorView(opts.mount, {
    state: EditorState.create({ doc: opts.doc, plugins }),
    nodeViews: createNodeViews(opts.ctx),
    attributes: { spellcheck: 'true', class: 'pm-root' },
    // Keep the caret comfortably away from the window edges while typing.
    scrollMargin: { top: 120, bottom: 160, left: 0, right: 0 },
    scrollThreshold: { top: 80, bottom: 120, left: 0, right: 0 },
    dispatchTransaction(tr) {
      view.updateState(view.state.apply(tr));
      opts.onChange(view, tr);
    },
    handleTextInput(view, from, to, text) {
      const { state } = view;
      const $from = state.doc.resolve(from);
      // "((" opens a sidenote.
      if (text === '(' && !$from.parent.type.spec.code && $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset) === '('
        && !schema.marks.code.isInSet($from.marks())) {
        view.dispatch(state.tr.replaceWith(from - 1, to, nodes.sidenote.create()));
        // The node view exists as soon as dispatch returns; focus now so no
        // keystrokes land in the outer document.
        sidenoteViewAt(view, from - 1)?.focus();
        return true;
      }
      // Typing while a sidenote is selected continues inside the note.
      const { selection } = state;
      if (selection instanceof NodeSelection && selection.node.type === nodes.sidenote) {
        const note = sidenoteViewAt(view, selection.from);
        if (note) {
          note.focus();
          note.inner.dispatch(note.inner.state.tr.insertText(text));
          return true;
        }
      }
      return false;
    },
    handleKeyDown(view, event) {
      const { selection } = view.state;
      if (event.key === 'Enter' && selection instanceof NodeSelection && selection.node.type === nodes.sidenote) {
        sidenoteViewAt(view, selection.from)?.focus();
        return true;
      }
      return false;
    },
    handleClickOn(view, _pos, _node, _nodePos, event) {
      // ⌘-click opens links.
      const link = (event.target as HTMLElement).closest('a[href]');
      if (link && (event.metaKey || event.ctrlKey)) {
        window.open((link as HTMLAnchorElement).href, '_blank', 'noopener');
        return true;
      }
      return false;
    },
    handlePaste(view, event) {
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.some((file) => file.type.startsWith('image/'))) {
        insertImages(view, opts.ctx, files);
        return true;
      }
      // Pasting a URL over selected text links it.
      const text = event.clipboardData?.getData('text/plain')?.trim() ?? '';
      const { selection } = view.state;
      if (!selection.empty && /^https?:\/\/\S+$/.test(text) && !inCode(view.state)) {
        view.dispatch(view.state.tr.addMark(selection.from, selection.to, schema.marks.link.create({ href: text })));
        return true;
      }
      return false;
    },
    handleDrop(view, event) {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (!files.some((file) => file.type.startsWith('image/'))) return false;
      event.preventDefault();
      const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
      insertImages(view, opts.ctx, files, at);
      return true;
    },
    // Plain-text clipboard is Markdown both ways.
    clipboardTextParser(text, $context) {
      if ($context.parent.type.spec.code) return new Slice(text ? Fragment.from(schema.text(text)) : Fragment.empty, 0, 0);
      return markdownToSlice(text, opts.mdx());
    },
    clipboardTextSerializer(slice) {
      return fragmentToMarkdown(slice.content, opts.mdx());
    },
  });

  return view;
}

export function replaceDoc(view: EditorView, doc: PMNode) {
  const state = EditorState.create({ doc, plugins: view.state.plugins });
  view.updateState(state);
  view.dispatch(view.state.tr.setSelection(Selection.atStart(view.state.doc)).setMeta('addToHistory', false));
}

export type { NodeType };
