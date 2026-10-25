import { Plugin, PluginKey, TextSelection, type EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { toggleMark } from 'prosemirror-commands';
import { insertMathInline, insertSidenote, markActive, markExtent } from './commands';
import { schema } from './schema';

// ── floating helpers ────────────────────────────────────────

function floating(className: string) {
  const el = document.createElement('div');
  el.className = `pm-floating ${className}`;
  document.body.append(el);
  return el;
}

// Position in document coordinates so page scrolling needs no updates.
function place(el: HTMLElement, rect: { left: number; top: number; bottom: number }, where: 'above' | 'below', center = false) {
  el.style.visibility = 'hidden';
  el.style.display = '';
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  let left = (center ? rect.left - width / 2 : rect.left) + window.scrollX;
  left = Math.max(window.scrollX + 8, Math.min(left, window.scrollX + document.documentElement.clientWidth - width - 8));
  let top = where === 'above' ? rect.top - height - 8 : rect.bottom + 6;
  if (where === 'above' && top < 8) top = rect.bottom + 8;
  if (where === 'below' && top + height > window.innerHeight - 8) top = rect.top - height - 6;
  el.style.left = `${left}px`;
  el.style.top = `${top + window.scrollY}px`;
  el.style.visibility = '';
}

// A one-line text prompt floating near the selection (used for links).
function prompt(view: EditorView, opts: { value: string; placeholder: string; at: number; onSubmit: (value: string) => void }) {
  const el = floating('pm-prompt');
  const input = document.createElement('input');
  input.value = opts.value;
  input.placeholder = opts.placeholder;
  input.spellcheck = false;
  el.append(input);
  const hint = document.createElement('span');
  hint.className = 'pm-prompt-hint';
  hint.textContent = opts.value ? '↵ save · empty to remove' : '↵ save';
  el.append(hint);
  place(el, view.coordsAtPos(opts.at), 'below');

  let done = false;
  const close = (submit: boolean) => {
    if (done) return;
    done = true;
    el.remove();
    if (submit) opts.onSubmit(input.value.trim());
    view.focus();
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close(false);
    }
  });
  input.addEventListener('blur', () => close(false));
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

export function editLink(view: EditorView) {
  const { state } = view;
  const type = schema.marks.link;
  const { from, to, empty, $from } = state.selection;
  const extent = markExtent($from, type);
  const range = extent && (empty || (extent.from <= from && to <= extent.to)) ? extent : { from, to, mark: null };
  prompt(view, {
    value: range.mark?.attrs.href ?? '',
    placeholder: 'https://…',
    at: range.from,
    onSubmit(href) {
      let tr = view.state.tr;
      if (!href) {
        if (range.mark) tr = tr.removeMark(range.from, range.to, type);
      } else if (range.from === range.to) {
        // No selection: insert the URL itself as the link text.
        tr = tr.insert(range.from, schema.text(href, [type.create({ href })]));
      } else {
        tr = tr.removeMark(range.from, range.to, type).addMark(range.from, range.to, type.create({ href }));
      }
      view.dispatch(tr);
    },
  });
  return true;
}

// ── slash menu ──────────────────────────────────────────────

export interface SlashItem {
  title: string;
  hint?: string;
  keywords?: string;
  section?: string;
  run: (view: EditorView) => unknown;
}

interface SlashState {
  active: boolean;
  from: number;
  query: string;
  index: number;
}

const slashKey = new PluginKey<SlashState>('slash');
const idle: SlashState = { active: false, from: 0, query: '', index: 0 };

function fuzzy(item: SlashItem, query: string) {
  if (!query) return 1;
  const haystack = `${item.title} ${item.keywords ?? ''}`.toLowerCase();
  if (haystack.startsWith(query)) return 3;
  if (haystack.split(/\s+/).some((word) => word.startsWith(query))) return 2;
  // Loose subsequence matching only against the title ("hd2" -> heading 2).
  let i = 0;
  for (const ch of item.title.toLowerCase()) if (ch === query[i]) i++;
  return i === query.length ? 0.5 : 0;
}

function matches(items: SlashItem[], query: string) {
  return items
    .map((item) => ({ item, score: fuzzy(item, query.toLowerCase()) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}

export function slashPlugin(getItems: () => SlashItem[]) {
  let menu: HTMLElement | null = null;

  const run = (view: EditorView, item: SlashItem) => {
    const state = slashKey.getState(view.state)!;
    const tr = view.state.tr.delete(state.from, view.state.selection.head).setMeta(slashKey, idle);
    view.dispatch(tr);
    item.run(view);
  };

  return new Plugin<SlashState>({
    key: slashKey,
    state: {
      init: () => idle,
      apply(tr, value, _old, state) {
        const meta = tr.getMeta(slashKey);
        if (meta) return meta;
        if (!value.active) return value;
        const from = tr.mapping.map(value.from);
        const { selection } = state;
        const $from = state.doc.resolve(from);
        if (!selection.empty || selection.head <= from || !$from.sameParent(selection.$head)) return idle;
        const text = state.doc.textBetween(from, selection.head);
        if (!text.startsWith('/') || /\s/.test(text) || text.length > 24) return idle;
        const query = text.slice(1);
        return { active: true, from, query, index: query === value.query ? value.index : 0 };
      },
    },
    props: {
      handleTextInput(view, from, to, text) {
        if (text !== '/') return false;
        const $from = view.state.doc.resolve(from);
        if ($from.parent.type.spec.code || !$from.parent.isTextblock) return false;
        const before = $from.parent.textBetween(0, $from.parentOffset, '\0', '\0');
        if (before && !/\s$/.test(before)) return false;
        view.dispatch(view.state.tr.insertText('/', from, to).setMeta(slashKey, { active: true, from, query: '', index: 0 }));
        return true;
      },
      handleKeyDown(view, event) {
        const state = slashKey.getState(view.state)!;
        if (!state.active) return false;
        const list = matches(getItems(), state.query);
        const move = (delta: number) => {
          view.dispatch(view.state.tr.setMeta(slashKey, { ...state, index: (state.index + delta + list.length) % Math.max(1, list.length) }));
          return true;
        };
        switch (event.key) {
          case 'ArrowDown': return move(1);
          case 'ArrowUp': return move(-1);
          case 'Tab': return move(event.shiftKey ? -1 : 1);
          case 'Enter':
            if (!list.length) {
              view.dispatch(view.state.tr.setMeta(slashKey, idle));
              return false;
            }
            run(view, list[state.index]);
            return true;
          case 'Escape':
            view.dispatch(view.state.tr.setMeta(slashKey, idle));
            return true;
          default:
            return false;
        }
      },
    },
    view() {
      return {
        update(view) {
          const state = slashKey.getState(view.state)!;
          const list = state.active ? matches(getItems(), state.query) : [];
          if (!state.active || !view.hasFocus()) {
            menu?.remove();
            menu = null;
            return;
          }
          menu ??= floating('pm-slash');
          menu.textContent = '';
          if (!list.length) {
            const empty = document.createElement('div');
            empty.className = 'pm-slash-empty';
            empty.textContent = 'no matches';
            menu.append(empty);
          }
          let section = '';
          list.forEach((item, index) => {
            if (!state.query && item.section && item.section !== section) {
              section = item.section;
              const heading = document.createElement('div');
              heading.className = 'pm-slash-section';
              heading.textContent = section;
              menu!.append(heading);
            }
            const row = document.createElement('button');
            row.type = 'button';
            row.className = `pm-slash-item${index === state.index ? ' is-active' : ''}`;
            row.innerHTML = '<span class="pm-slash-title"></span><span class="pm-slash-hint"></span>';
            row.firstElementChild!.textContent = item.title;
            row.lastElementChild!.textContent = item.hint ?? '';
            row.addEventListener('mousedown', (event) => {
              event.preventDefault();
              run(view, item);
            });
            menu!.append(row);
            if (index === state.index) requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest' }));
          });
          place(menu, view.coordsAtPos(state.from), 'below');
        },
        destroy() {
          menu?.remove();
          menu = null;
        },
      };
    },
  });
}

// ── selection toolbar ───────────────────────────────────────

interface BubbleButton {
  label: string;
  title: string;
  className?: string;
  active?: (state: EditorState) => boolean;
  run: (view: EditorView) => unknown;
}

const BUTTONS: BubbleButton[] = [
  { label: 'B', title: 'bold (⌘B)', className: 'is-bold', active: (s) => markActive(s, schema.marks.strong), run: (v) => toggleMark(schema.marks.strong)(v.state, v.dispatch) },
  { label: 'I', title: 'italic (⌘I)', className: 'is-italic', active: (s) => markActive(s, schema.marks.em), run: (v) => toggleMark(schema.marks.em)(v.state, v.dispatch) },
  { label: 'S', title: 'strikethrough (⌘⇧X)', className: 'is-strike', active: (s) => markActive(s, schema.marks.strike), run: (v) => toggleMark(schema.marks.strike)(v.state, v.dispatch) },
  { label: '<>', title: 'inline code (⌘E)', active: (s) => markActive(s, schema.marks.code), run: (v) => toggleMark(schema.marks.code)(v.state, v.dispatch) },
  { label: 'link', title: 'link (⌘K)', active: (s) => markActive(s, schema.marks.link), run: editLink },
  { label: 'note', title: 'move into a sidenote (⌘⌥N)', run: insertSidenote },
  { label: '∑', title: 'inline math (⌘⌥M)', run: insertMathInline },
];

export function bubblePlugin() {
  let bar: HTMLElement | null = null;
  let buttons: { el: HTMLButtonElement; spec: BubbleButton }[] = [];
  let pointerDown = false;

  return new Plugin({
    view(view) {
      const onDown = () => (pointerDown = true);
      const onUp = () => {
        pointerDown = false;
        requestAnimationFrame(() => !view.isDestroyed && update(view));
      };
      view.dom.addEventListener('mousedown', onDown);
      document.addEventListener('mouseup', onUp);

      function build() {
        bar = floating('pm-bubble');
        buttons = BUTTONS.map((spec) => {
          const el = document.createElement('button');
          el.type = 'button';
          el.textContent = spec.label;
          el.title = spec.title;
          if (spec.className) el.classList.add(spec.className);
          el.addEventListener('mousedown', (event) => {
            event.preventDefault();
            spec.run(view);
          });
          bar!.append(el);
          return { el, spec };
        });
      }

      function update(view: EditorView) {
        const { selection } = view.state;
        const show = view.hasFocus() && !pointerDown && selection instanceof TextSelection && !selection.empty
          && !selection.$from.parent.type.spec.code && view.state.doc.textBetween(selection.from, selection.to).trim();
        if (!show) {
          if (bar) bar.style.display = 'none';
          return;
        }
        if (!bar) build();
        for (const { el, spec } of buttons) el.classList.toggle('is-active', !!spec.active?.(view.state));
        const start = view.coordsAtPos(selection.from);
        const end = view.coordsAtPos(selection.to);
        const sameLine = Math.abs(start.top - end.top) < 4;
        const left = sameLine ? (start.left + end.left) / 2 : start.left;
        place(bar!, { left, top: Math.min(start.top, end.top), bottom: Math.max(start.bottom, end.bottom) }, 'above', sameLine);
      }

      return {
        update,
        destroy() {
          view.dom.removeEventListener('mousedown', onDown);
          document.removeEventListener('mouseup', onUp);
          bar?.remove();
        },
      };
    },
    props: {
      handleDOMEvents: {
        blur(view) {
          requestAnimationFrame(() => {
            if (bar && !view.hasFocus()) bar.style.display = 'none';
          });
          return false;
        },
      },
    },
  });
}
