import katex from 'katex';
import { h, render } from 'preact';
import { EditorState, NodeSelection, Selection, TextSelection, type Plugin } from 'prosemirror-state';
import { EditorView, type NodeView, type NodeViewConstructor } from 'prosemirror-view';
import { StepMap } from 'prosemirror-transform';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import { redo, undo } from 'prosemirror-history';
import type { Node as PMNode } from 'prosemirror-model';
import { parseComponent } from './markdown';
import { schema } from './schema';

export interface EditorContext {
  upload: (file: File) => Promise<string>;
  componentUrl: (name: string) => string | null;
  // Plugins shared by the nested sidenote editors (caret, marks, input rules).
  innerPlugins: () => Plugin[];
}

type GetPos = () => number | undefined;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, parent?: HTMLElement) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  parent?.append(node);
  return node;
}

// ⌘S should still reach the window-level save handler.
const isSaveKey = (event: KeyboardEvent) => (event.metaKey || event.ctrlKey) && event.key === 's';

function renderTex(target: HTMLElement, tex: string, displayMode: boolean) {
  if (!tex.trim()) {
    target.textContent = displayMode ? 'empty equation' : '∅';
    target.classList.add('is-empty');
    return;
  }
  target.classList.remove('is-empty');
  katex.render(tex, target, { displayMode, throwOnError: false, strict: 'ignore' });
}

// Leave a node view for the text beside it. Never lands on a neighbouring
// atom (which would open its editor and swallow the next keystrokes): if
// the neighbour isn't text, an empty paragraph is made there.
export function placeCursor(view: EditorView, pos: number, bias: 1 | -1) {
  let tr = view.state.tr;
  const $pos = tr.doc.resolve(pos);
  let target: number;
  if ($pos.parent.inlineContent) {
    target = pos;
  } else {
    const neighbour = bias > 0 ? $pos.nodeAfter : $pos.nodeBefore;
    if (neighbour?.isTextblock) {
      target = bias > 0 ? pos + 1 : pos - 1;
    } else {
      tr = tr.insert(pos, schema.nodes.paragraph.create());
      target = pos + 1;
    }
  }
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, target)).scrollIntoView());
  view.focus();
}

// Typing into a textarea with an always-fitting height.
function autosize(textarea: HTMLTextAreaElement) {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}

// ── sidenote ────────────────────────────────────────────────
// Adapted from ProseMirror's footnote example: the note is an inline atom
// in the outer document whose content is edited by a nested EditorView,
// rendered with the site's own sidenote markup so it sits in the margin.

export class SidenoteView implements NodeView {
  dom: HTMLElement;
  inner: EditorView;

  constructor(private node: PMNode, private outer: EditorView, private getPos: GetPos, ctx: EditorContext) {
    this.dom = el('span', 'pm-sidenote');
    const label = el('label', 'sidenote-number', this.dom);
    label.contentEditable = 'false';
    label.addEventListener('mousedown', (event) => {
      event.preventDefault();
      this.focus();
    });
    const note = el('span', 'sidenote', this.dom);
    (this.dom as any).pmSidenote = this;

    this.inner = new EditorView(note, {
      state: EditorState.create({
        doc: node,
        plugins: [
          keymap({
            'Mod-z': () => undo(outer.state, outer.dispatch),
            'Shift-Mod-z': () => redo(outer.state, outer.dispatch),
            'Mod-y': () => redo(outer.state, outer.dispatch),
            Escape: () => this.exit(1),
            Enter: () => this.exit(1),
            'Shift-Enter': (state, dispatch) => {
              dispatch?.(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
              return true;
            },
            ArrowRight: (state) => state.selection.empty && state.selection.head === state.doc.content.size && this.exit(1),
            ArrowLeft: (state) => state.selection.empty && state.selection.head === 0 && this.exit(-1),
            // Backspace in an empty note removes it.
            Backspace: (state) => {
              if (state.doc.content.size || !state.selection.empty) return false;
              const pos = this.getPos();
              if (pos == null) return false;
              this.outer.dispatch(this.outer.state.tr.delete(pos, pos + this.node.nodeSize));
              placeCursor(this.outer, pos, -1);
              return true;
            },
          }),
          ...ctx.innerPlugins(),
          keymap(baseKeymap),
        ],
      }),
      dispatchTransaction: (tr) => this.dispatchInner(tr),
      nodeViews: { math_inline: inlineSourceView('tex'), raw_inline: inlineSourceView('source') },
      attributes: { spellcheck: 'true' },
    });
    this.syncEmpty();
  }

  private dispatchInner(tr: import('prosemirror-state').Transaction) {
    const { state, transactions } = this.inner.state.applyTransaction(tr);
    this.inner.updateState(state);
    if (!tr.getMeta('fromOutside')) {
      const pos = this.getPos();
      if (pos == null) return;
      const outerTr = this.outer.state.tr;
      const offset = StepMap.offset(pos + 1);
      for (const t of transactions) for (const step of t.steps) outerTr.step(step.map(offset)!);
      if (outerTr.docChanged) this.outer.dispatch(outerTr);
    }
    this.syncEmpty();
  }

  private syncEmpty() {
    this.dom.classList.toggle('is-empty', this.inner.state.doc.content.size === 0);
  }

  update(node: PMNode) {
    if (!node.sameMarkup(this.node)) return false;
    this.node = node;
    const state = this.inner.state;
    const start = node.content.findDiffStart(state.doc.content);
    if (start != null) {
      let { a: endA, b: endB } = node.content.findDiffEnd(state.doc.content)!;
      const overlap = start - Math.min(endA, endB);
      if (overlap > 0) {
        endA += overlap;
        endB += overlap;
      }
      this.inner.dispatch(state.tr.replace(start, endB, node.slice(start, endA)).setMeta('fromOutside', true));
    }
    return true;
  }

  focus(atStart = false) {
    const doc = this.inner.state.doc;
    this.inner.dispatch(this.inner.state.tr.setSelection(atStart ? Selection.atStart(doc) : Selection.atEnd(doc)));
    this.inner.focus();
  }

  exit(direction: 1 | -1) {
    const pos = this.getPos();
    if (pos == null) return false;
    const target = direction > 0 ? pos + this.node.nodeSize : pos;
    this.outer.dispatch(this.outer.state.tr.setSelection(TextSelection.create(this.outer.state.doc, target)));
    this.outer.focus();
    return true;
  }

  selectNode() {
    this.dom.classList.add('is-selected');
  }

  deselectNode() {
    this.dom.classList.remove('is-selected');
  }

  stopEvent(event: Event) {
    return this.inner.dom.contains(event.target as Node);
  }

  ignoreMutation() {
    return true;
  }

  destroy() {
    this.inner.destroy();
  }
}

// ── inline source atoms: $math$ and raw inline HTML ─────────
// Rendered in place; selecting one opens a small source popover.

function renderRawInline(target: HTMLElement, source: string) {
  target.textContent = '';
  // Self-contained tags render; stray open/close tags show as chips.
  if (/^<(img|br|wbr)\b[^>]*>$/i.test(source.trim()) || /^<([a-z][\w-]*)\b[^>]*>[\s\S]*<\/\1>$/i.test(source.trim())) {
    target.innerHTML = source;
    target.classList.remove('is-chip');
  } else {
    target.textContent = source;
    target.classList.add('is-chip');
  }
}

class InlineSourceView implements NodeView {
  dom: HTMLElement;
  private preview: HTMLElement;
  private popover: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;

  constructor(private node: PMNode, private view: EditorView, private getPos: GetPos, private attr: 'tex' | 'source') {
    this.dom = el('span', attr === 'tex' ? 'pm-math-inline' : 'pm-raw-inline');
    this.dom.contentEditable = 'false';
    this.preview = el('span', 'pm-inline-preview', this.dom);
    this.draw();
  }

  private get value(): string {
    return this.node.attrs[this.attr];
  }

  private draw() {
    if (this.attr === 'tex') renderTex(this.preview, this.value, false);
    else renderRawInline(this.preview, this.value);
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.draw();
    if (this.input && this.input.value !== this.value) this.input.value = this.value;
    return true;
  }

  selectNode() {
    this.dom.classList.add('is-selected');
    if (this.popover) return;
    this.popover = el('span', 'pm-popover pm-inline-popover', this.dom);
    const prefix = el('span', 'pm-popover-affix', this.popover);
    prefix.textContent = this.attr === 'tex' ? '$' : '';
    const input = (this.input = el('input', 'pm-popover-input', this.popover));
    input.value = this.value;
    input.spellcheck = false;
    input.placeholder = this.attr === 'tex' ? 'e^{i\\pi} + 1 = 0' : '<sub>html</sub>';
    input.size = Math.max(12, this.value.length + 2);
    const suffix = el('span', 'pm-popover-affix', this.popover);
    suffix.textContent = this.attr === 'tex' ? '$' : '';

    input.addEventListener('input', () => {
      input.size = Math.max(12, input.value.length + 2);
      const pos = this.getPos();
      if (pos != null) this.view.dispatch(this.view.state.tr.setNodeAttribute(pos, this.attr, input.value));
    });
    input.addEventListener('keydown', (event) => {
      // Keys typed here belong to the input, never to the outer editor
      // (the popover may be gone by the time the event bubbles up).
      if (!isSaveKey(event)) event.stopPropagation();
      const pos = this.getPos();
      if (pos == null) return;
      const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
      const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
      if (event.key === 'Enter' || event.key === 'Escape' || event.key === 'Tab' || (event.key === 'ArrowRight' && atEnd)) {
        event.preventDefault();
        placeCursor(this.view, pos + this.node.nodeSize, 1);
      } else if (event.key === 'ArrowLeft' && atStart) {
        event.preventDefault();
        placeCursor(this.view, pos, -1);
      } else if (event.key === 'Backspace' && !input.value) {
        event.preventDefault();
        this.view.dispatch(this.view.state.tr.delete(pos, pos + this.node.nodeSize));
        placeCursor(this.view, pos, -1);
      }
    });
    // Focus synchronously: keystrokes typed right after selecting must go
    // to the input, not replace the selected node.
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  deselectNode() {
    this.dom.classList.remove('is-selected');
    this.popover?.remove();
    this.popover = this.input = null;
  }

  stopEvent(event: Event) {
    return event.target instanceof HTMLInputElement || !!this.popover?.contains(event.target as Node);
  }

  ignoreMutation() {
    return true;
  }
}

function inlineSourceView(attr: 'tex' | 'source'): NodeViewConstructor {
  return (node, view, getPos) => new InlineSourceView(node, view, getPos, attr);
}

// ── block source atoms: $$math$$, raw HTML, MDX components ──
// A live preview, with the source in a textarea while selected.

const componentModules = new Map<string, Promise<any>>();

class BlockSourceView implements NodeView {
  dom: HTMLElement;
  private preview: HTMLElement;
  private editor: HTMLElement;
  private textarea: HTMLTextAreaElement;
  private renderedValue: string | null = null;

  constructor(private node: PMNode, private view: EditorView, private getPos: GetPos, private ctx: EditorContext) {
    const kind = node.type.name;
    this.dom = el('div', `pm-block-source pm-${kind.replace('_', '-')}`);
    this.dom.contentEditable = 'false';
    const tag = el('div', 'pm-block-tag', this.dom);
    tag.textContent = kind === 'math_block' ? 'math' : kind === 'component' ? node.attrs.name : 'html';
    this.preview = el('div', 'pm-block-preview', this.dom);
    this.editor = el('div', 'pm-block-editor', this.dom);
    this.textarea = el('textarea', 'pm-block-textarea', this.editor);
    this.textarea.spellcheck = false;
    this.textarea.placeholder = kind === 'math_block' ? '\\int_0^1 x^2 \\, dx' : kind === 'component' ? '<Diagram client:visible />' : '<div>…</div>';
    const hint = el('div', 'pm-block-hint', this.editor);
    hint.textContent = 'esc to finish · ⌘↵ new line after';

    this.textarea.addEventListener('input', () => {
      autosize(this.textarea);
      const pos = this.getPos();
      if (pos != null) this.view.dispatch(this.view.state.tr.setNodeAttribute(pos, this.attr, this.textarea.value));
    });
    this.textarea.addEventListener('keydown', (event) => this.onKey(event));
    this.draw();
  }

  private get attr() {
    return this.node.type.name === 'math_block' ? 'tex' : 'source';
  }

  private get value(): string {
    return this.node.attrs[this.attr];
  }

  private onKey(event: KeyboardEvent) {
    if (!isSaveKey(event)) event.stopPropagation();
    const pos = this.getPos();
    if (pos == null) return;
    const { selectionStart, selectionEnd, value } = this.textarea;
    const after = pos + this.node.nodeSize;
    if (event.key === 'Escape' || ((event.metaKey || event.ctrlKey) && event.key === 'Enter')) {
      event.preventDefault();
      placeCursor(this.view, after, 1);
    } else if (event.key === 'ArrowUp' && selectionStart === 0 && selectionEnd === 0) {
      event.preventDefault();
      placeCursor(this.view, pos, -1);
    } else if (event.key === 'ArrowDown' && selectionStart === value.length) {
      event.preventDefault();
      placeCursor(this.view, after, 1);
    } else if (event.key === 'Backspace' && !value) {
      event.preventDefault();
      const tr = this.view.state.tr.replaceWith(pos, after, schema.nodes.paragraph.create());
      this.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 1)));
      this.view.focus();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      this.textarea.setRangeText('  ', selectionStart, selectionEnd, 'end');
      this.textarea.dispatchEvent(new Event('input'));
    }
  }

  private draw() {
    if (this.renderedValue === this.value) return;
    this.renderedValue = this.value;
    const kind = this.node.type.name;
    if (kind === 'math_block') renderTex(this.preview, this.value, true);
    else if (kind === 'component') this.drawComponent();
    else this.preview.innerHTML = this.value || '<span class="is-empty">empty html block</span>';
  }

  private drawComponent() {
    const source = this.value;
    let parsed: ReturnType<typeof parseComponent> = null;
    try {
      parsed = parseComponent(source);
    } catch (error) {
      return this.componentError(`can't parse: ${(error as Error).message}`);
    }
    const url = parsed && this.ctx.componentUrl(parsed.name);
    if (!parsed || !url) return this.componentError(parsed ? `unknown component ${parsed.name}` : 'not a component');

    if (!componentModules.has(url)) componentModules.set(url, import(/* @vite-ignore */ url));
    componentModules.get(url)!.then((module) => {
      if (this.renderedValue !== source) return;
      const Component = module.default ?? module[parsed!.name];
      try {
        render(h(Component, parsed!.props), this.preview);
      } catch (error) {
        this.componentError((error as Error).message);
      }
    }, (error) => this.componentError(error.message));
  }

  private componentError(message: string) {
    render(null, this.preview);
    this.preview.innerHTML = '';
    const box = el('div', 'pm-component-error', this.preview);
    box.textContent = message;
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (this.textarea.value !== this.value) {
      this.textarea.value = this.value;
      autosize(this.textarea);
    }
    this.draw();
    return true;
  }

  selectNode() {
    this.dom.classList.add('is-selected', 'is-editing');
    this.textarea.value = this.value;
    this.textarea.focus();
    autosize(this.textarea);
  }

  deselectNode() {
    this.dom.classList.remove('is-selected', 'is-editing');
  }

  stopEvent(event: Event) {
    // Clicks on the preview should still select the node; component previews
    // are interactive, so let them keep their own events.
    if (this.editor.contains(event.target as Node)) return true;
    return this.node.type.name === 'component' && this.preview.contains(event.target as Node) && event.type !== 'mousedown';
  }

  ignoreMutation() {
    return true;
  }

  destroy() {
    if (this.node.type.name === 'component') render(null, this.preview);
  }
}

// ── code blocks (and ```gallery) ────────────────────────────

class CodeBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private lang: HTMLInputElement;
  private gallery: HTMLElement;
  private galleryText: string | null = null;

  constructor(private node: PMNode, private view: EditorView, private getPos: GetPos, private ctx: EditorContext) {
    this.dom = el('div', 'pm-code');
    const header = el('div', 'pm-code-header', this.dom);
    header.contentEditable = 'false';
    this.lang = el('input', 'pm-code-lang', header);
    this.lang.placeholder = 'lang';
    this.lang.spellcheck = false;
    this.lang.value = node.attrs.lang;
    this.lang.addEventListener('input', () => {
      const pos = this.getPos();
      if (pos != null) this.view.dispatch(this.view.state.tr.setNodeAttribute(pos, 'lang', this.lang.value.trim()));
    });
    this.lang.addEventListener('keydown', (event) => {
      if (!isSaveKey(event)) event.stopPropagation();
      if (event.key === 'Enter' || event.key === 'Escape' || event.key === 'ArrowDown') {
        event.preventDefault();
        const pos = this.getPos();
        if (pos != null) {
          this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, pos + 1)));
          this.view.focus();
        }
      }
    });

    const pre = el('pre', 'astro-code pm-code-pre', this.dom);
    this.contentDOM = el('code', undefined, pre);
    this.gallery = el('div', 'pm-gallery', this.dom);
    this.gallery.contentEditable = 'false';
    this.sync();
  }

  private sync() {
    const isGallery = this.node.attrs.lang === 'gallery';
    this.dom.classList.toggle('is-gallery', isGallery);
    if (!isGallery) {
      this.gallery.textContent = '';
      this.galleryText = null;
      return;
    }
    const text = this.node.textContent;
    if (text === this.galleryText) return;
    this.galleryText = text;
    this.gallery.textContent = '';
    for (const line of text.split('\n')) {
      const [src, ...alt] = line.trim().split('|');
      if (!src || src.startsWith('#')) continue;
      const img = el('img', 'pm-gallery-thumb', this.gallery);
      img.src = /^https?:/.test(src) ? src : `/${src.replace(/^\/?(public\/)?/, '')}`;
      img.alt = alt.join('|').trim();
      img.title = img.alt;
    }
    const add = el('button', 'pm-gallery-add', this.gallery);
    add.type = 'button';
    add.textContent = '+ images';
    add.addEventListener('click', () => pickFiles(true).then((files) => this.addImages(files)));
  }

  private async addImages(files: File[]) {
    const lines = [];
    for (const file of files) lines.push(await this.ctx.upload(file));
    const pos = this.getPos();
    if (pos == null || !lines.length) return;
    const end = pos + this.node.nodeSize - 1;
    const prefix = this.node.textContent && !this.node.textContent.endsWith('\n') ? '\n' : '';
    this.view.dispatch(this.view.state.tr.insertText(prefix + lines.map((src) => `${src} | `).join('\n'), end));
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (document.activeElement !== this.lang) this.lang.value = node.attrs.lang;
    this.sync();
    return true;
  }

  stopEvent(event: Event) {
    const target = event.target as Node;
    return this.lang.contains(target) || this.gallery.contains(target);
  }

  ignoreMutation(mutation: MutationRecord | { type: 'selection'; target: Node }) {
    if (mutation.type === 'selection') return false;
    return !this.contentDOM.contains(mutation.target);
  }
}

// ── images ──────────────────────────────────────────────────

class ImageView implements NodeView {
  dom: HTMLElement;
  private img: HTMLImageElement;
  private alt: HTMLInputElement;
  private src: HTMLInputElement;

  constructor(private node: PMNode, private view: EditorView, private getPos: GetPos) {
    this.dom = el('figure', 'pm-image');
    this.dom.contentEditable = 'false';
    this.img = el('img', undefined, this.dom);
    // A just-uploaded file can 404 until Vite's public-dir watcher sees it.
    let retries = 0;
    this.img.addEventListener('load', () => (retries = 0));
    this.img.addEventListener('error', () => {
      const src = this.node.attrs.src;
      if (retries++ < 6 && src.startsWith('/')) window.setTimeout(() => (this.img.src = `${src}?retry=${retries}`), 250 * retries);
    });
    const fields = el('div', 'pm-image-fields', this.dom);
    this.alt = el('input', 'pm-image-alt', fields);
    this.alt.placeholder = 'describe the image (alt text, used by search + screen readers)';
    this.src = el('input', 'pm-image-src', fields);
    this.src.placeholder = '/images/…';
    this.src.spellcheck = false;
    for (const [input, attr] of [[this.alt, 'alt'], [this.src, 'src']] as const) {
      input.addEventListener('input', () => {
        const pos = this.getPos();
        if (pos != null) this.view.dispatch(this.view.state.tr.setNodeAttribute(pos, attr, input.value));
      });
      input.addEventListener('keydown', (event) => {
        if (!isSaveKey(event)) event.stopPropagation();
        const pos = this.getPos();
        if (pos == null) return;
        if (event.key === 'Enter' || event.key === 'Escape') {
          event.preventDefault();
          placeCursor(this.view, pos + this.node.nodeSize, 1);
        }
      });
    }
    this.sync();
  }

  private sync() {
    const { src, alt } = this.node.attrs;
    if (this.img.getAttribute('src')?.split('?retry=')[0] !== src) this.img.src = src;
    this.img.alt = alt;
    if (document.activeElement !== this.alt) this.alt.value = alt;
    if (document.activeElement !== this.src) this.src.value = src;
    this.dom.classList.toggle('needs-alt', !alt.trim());
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.sync();
    return true;
  }

  selectNode() {
    this.dom.classList.add('is-selected');
  }

  deselectNode() {
    this.dom.classList.remove('is-selected');
  }

  stopEvent(event: Event) {
    return event.target instanceof HTMLInputElement;
  }

  ignoreMutation() {
    return true;
  }
}

export function pickFiles(multiple = false, accept = 'image/*') {
  return new Promise<File[]>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener('change', () => resolve([...(input.files ?? [])]));
    input.click();
  });
}

export function createNodeViews(ctx: EditorContext): Record<string, NodeViewConstructor> {
  return {
    sidenote: (node, view, getPos) => new SidenoteView(node, view, getPos, ctx),
    math_inline: inlineSourceView('tex'),
    raw_inline: inlineSourceView('source'),
    math_block: (node, view, getPos) => new BlockSourceView(node, view, getPos, ctx),
    raw_block: (node, view, getPos) => new BlockSourceView(node, view, getPos, ctx),
    component: (node, view, getPos) => new BlockSourceView(node, view, getPos, ctx),
    code_block: (node, view, getPos) => new CodeBlockView(node, view, getPos, ctx),
    image: (node, view, getPos) => new ImageView(node, view, getPos),
  };
}

export function sidenoteViewAt(view: EditorView, pos: number): SidenoteView | null {
  return ((view.nodeDOM(pos) as any)?.pmSidenote as SidenoteView) ?? null;
}

export { NodeSelection };
