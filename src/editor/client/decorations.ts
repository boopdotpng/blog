import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { StepMap } from 'prosemirror-transform';
import { schema } from './schema';

// ── callouts ────────────────────────────────────────────────
// Same rule as scripts/remark-callout.mjs: a blockquote whose text starts
// with "Note:", "tl;dr:", "Update:" or "Warning:" is styled as a callout.

export const CALLOUTS = [
  { re: /^update:/i, type: 'update', label: 'Update:' },
  { re: /^tl;?dr:/i, type: 'tldr', label: 'tl;dr:' },
  { re: /^note:/i, type: 'note', label: 'Note:' },
  { re: /^warning:/i, type: 'warning', label: 'Warning:' },
];

function calloutDecorations(doc: PMNode) {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type !== schema.nodes.blockquote) return true;
    let found = false;
    node.descendants((child, childPos) => {
      if (found) return false;
      if (!child.isText) return true;
      found = true;
      for (const { re, type } of CALLOUTS) {
        const match = re.exec(child.text!);
        if (!match) continue;
        decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: `callout callout-${type}` }));
        const start = pos + 1 + childPos;
        decorations.push(Decoration.inline(start, start + match[0].length, { class: 'callout-label' }));
        break;
      }
      return false;
    });
    return true;
  });
  return DecorationSet.create(doc, decorations);
}

export const calloutPlugin = new Plugin({
  state: {
    init: (_, state) => calloutDecorations(state.doc),
    apply: (tr, set) => (tr.docChanged ? calloutDecorations(tr.doc) : set),
  },
  props: {
    decorations(state) {
      return this.getState(state);
    },
  },
});

// ── placeholders ────────────────────────────────────────────

export const placeholderPlugin = new Plugin({
  props: {
    decorations(state) {
      const { doc, selection } = state;
      const decorations: Decoration[] = [];
      if (doc.childCount === 1 && doc.firstChild!.type === schema.nodes.paragraph && !doc.firstChild!.content.size) {
        decorations.push(Decoration.node(0, doc.firstChild!.nodeSize, {
          class: 'is-placeholder',
          'data-placeholder': 'start writing — type / for blocks, (( for a sidenote',
        }));
      } else if (selection.empty) {
        const $from = selection.$from;
        const parent = $from.parent;
        if (parent.isTextblock && !parent.content.size && !parent.type.spec.code) {
          const pos = $from.before();
          decorations.push(Decoration.node(pos, pos + parent.nodeSize, {
            class: 'is-placeholder',
            'data-placeholder': parent.type === schema.nodes.heading ? `heading ${parent.attrs.level}` : 'type / for blocks',
          }));
        }
      }
      return DecorationSet.create(doc, decorations);
    },
  },
});

// ── syntax highlighting ─────────────────────────────────────
// Shiki with the site's own themes, so code looks the way it will publish.
// Tokenizing is async (grammars load lazily); results are cached per
// (lang, code), and only code blocks touched by an edit are redrawn.

const THEMES = { light: 'github-light', dark: 'github-dark-dimmed' } as const;
const highlightKey = new PluginKey<DecorationSet>('highlight');

type Token = { from: number; to: number; style: string };
const tokenCache = new Map<string, Token[] | null>();
let highlighter: Promise<any> | null = null;
const loadedLangs = new Map<string, Promise<boolean>>();

function getHighlighter() {
  highlighter ??= import('shiki').then(({ createHighlighter }) => createHighlighter({ themes: Object.values(THEMES), langs: [] }));
  return highlighter;
}

function loadLang(lang: string) {
  if (!loadedLangs.has(lang)) {
    loadedLangs.set(lang, getHighlighter().then(async (hl) => {
      try {
        await hl.loadLanguage(lang);
        return true;
      } catch {
        return false;
      }
    }));
  }
  return loadedLangs.get(lang)!;
}

const styleOf = (style: Record<string, string> | undefined) =>
  style ? Object.entries(style).map(([key, value]) => `${key}:${value}`).join(';') : '';

function tokenize(lang: string, code: string): Token[] | null | undefined {
  const key = `${lang}\0${code}`;
  if (tokenCache.has(key)) return tokenCache.get(key);
  return undefined;
}

async function tokenizeAsync(lang: string, code: string) {
  const key = `${lang}\0${code}`;
  if (!(await loadLang(lang))) {
    tokenCache.set(key, null);
    return;
  }
  const hl = await getHighlighter();
  const { tokens } = hl.codeToTokens(code, { lang, themes: THEMES, defaultColor: false });
  const out: Token[] = [];
  for (const line of tokens) {
    for (const token of line) {
      if (!token.content.trim()) continue;
      out.push({ from: token.offset, to: token.offset + token.content.length, style: styleOf(token.htmlStyle) });
    }
  }
  // Bound the cache; old keystroke snapshots are never needed again.
  if (tokenCache.size > 400) tokenCache.delete(tokenCache.keys().next().value!);
  tokenCache.set(key, out);
}

const PLAIN = new Set(['', 'text', 'txt', 'plain', 'gallery']);

function blockDecorations(node: PMNode, pos: number, pending: Set<string>) {
  const lang = node.attrs.lang.toLowerCase();
  const code = node.textContent;
  if (PLAIN.has(lang) || !code) return [];
  const tokens = tokenize(lang, code);
  if (tokens === undefined) {
    pending.add(`${lang}\0${code}`);
    return [];
  }
  return (tokens ?? []).map((token) => Decoration.inline(pos + 1 + token.from, pos + 1 + token.to, { style: token.style }));
}

function codeBlocksIn(doc: PMNode, from: number, to: number, visit: (node: PMNode, pos: number) => void) {
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === schema.nodes.code_block) {
      visit(node, pos);
      return false;
    }
    return true;
  });
}

export function highlightPlugin() {
  let view: EditorView | null = null;
  const pending = new Set<string>();

  function flush() {
    if (!pending.size) return;
    const jobs = [...pending].map((key) => {
      const [lang, code] = key.split('\0');
      return tokenizeAsync(lang, code);
    });
    pending.clear();
    Promise.all(jobs).then(() => view && !view.isDestroyed && view.dispatch(view.state.tr.setMeta(highlightKey, 'refresh')));
  }

  function full(state: EditorState | { doc: PMNode }) {
    const decorations: Decoration[] = [];
    codeBlocksIn(state.doc, 0, state.doc.content.size, (node, pos) => decorations.push(...blockDecorations(node, pos, pending)));
    return DecorationSet.create(state.doc, decorations);
  }

  return new Plugin<DecorationSet>({
    key: highlightKey,
    state: {
      init: (_, state) => full(state),
      apply(tr, set) {
        if (tr.getMeta(highlightKey) === 'refresh') return full(tr);
        if (!tr.docChanged) return set;
        // Attribute changes (e.g. a new language) have no step map to diff.
        if (tr.steps.some((step) => step.getMap() === StepMap.empty)) return full(tr);
        set = set.map(tr.mapping, tr.doc);
        // Redraw just the code blocks overlapping changed ranges.
        const ranges: [number, number][] = [];
        tr.mapping.maps.forEach((map, index) => {
          map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
            const rest = tr.mapping.slice(index + 1);
            ranges.push([rest.map(newStart, -1), rest.map(newEnd, 1)]);
          });
        });
        for (const [from, to] of ranges) {
          codeBlocksIn(tr.doc, Math.max(0, from), Math.min(tr.doc.content.size, to), (node, pos) => {
            set = set.remove(set.find(pos, pos + node.nodeSize)).add(tr.doc, blockDecorations(node, pos, pending));
          });
        }
        return set;
      },
    },
    view(editorView) {
      view = editorView;
      flush();
      return { update: flush, destroy: () => { view = null; } };
    },
    props: {
      decorations(state) {
        return highlightKey.getState(state);
      },
    },
  });
}
