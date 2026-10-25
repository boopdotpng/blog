// A smooth, animated caret. The native caret is hidden (caret-color:
// transparent) and a single element glides to wherever the focused editor's
// cursor is. One manager serves the main editor and every nested sidenote
// editor, so the caret can slide between them.

import { Plugin, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

class CaretManager {
  private el: HTMLDivElement | null = null;
  private views = new Set<EditorView>();
  private frame = 0;
  private animateNext = false;
  private visible = false;
  private last = { x: -1, y: -1, h: 0 };

  private ensure() {
    if (this.el) return this.el;
    this.el = document.createElement('div');
    this.el.className = 'pm-smooth-caret';
    this.el.setAttribute('aria-hidden', 'true');
    document.body.append(this.el);
    // Layout shifts (images loading, the window resizing, inner scroll
    // containers) move the caret without animating it.
    window.addEventListener('resize', () => this.schedule(false));
    document.addEventListener('scroll', (event) => {
      if (event.target !== document) this.schedule(false);
    }, true);
    document.addEventListener('selectionchange', () => this.schedule(true));
    new ResizeObserver(() => this.schedule(false)).observe(document.body);
    return this.el;
  }

  schedule(animate: boolean) {
    this.animateNext ||= animate;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const animateNow = this.animateNext;
      this.animateNext = false;
      this.draw(animateNow);
    });
  }

  private hide() {
    if (!this.visible || !this.el) return;
    this.visible = false;
    this.el.classList.remove('is-visible');
  }

  private draw(animate: boolean) {
    const el = this.ensure();
    const view = [...this.views].find((v) => !v.isDestroyed && v.hasFocus());
    const selection = view?.state.selection;
    if (!view || !(selection instanceof TextSelection) || !selection.empty || view.composing) return this.hide();

    let rect: { left: number; top: number; bottom: number } | null = nativeCaretRect(view);
    if (!rect) {
      try {
        rect = view.coordsAtPos(selection.head, selection.$head.parentOffset === 0 ? 1 : -1);
      } catch {
        return this.hide();
      }
    }
    const x = Math.round(rect.left + window.scrollX);
    const y = Math.round(rect.top + window.scrollY);
    const h = Math.max(4, Math.round(rect.bottom - rect.top));
    if (x === this.last.x && y === this.last.y && h === this.last.h && this.visible) return;

    // Appearing (or a layout-only shift) snaps; real cursor moves glide.
    el.classList.toggle('no-transition', !animate || !this.visible);
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    el.style.height = `${h}px`;
    this.last = { x, y, h };

    if (!this.visible) {
      this.visible = true;
      el.classList.add('is-visible');
    }
  }

  plugin() {
    return new Plugin({
      view: (view) => {
        this.views.add(view);
        view.dom.classList.add('has-smooth-caret');
        this.schedule(false);
        return {
          update: (_view, previous) => {
            if (!previous.selection.eq(view.state.selection) || !previous.doc.eq(view.state.doc)) this.schedule(true);
          },
          destroy: () => {
            this.views.delete(view);
            this.schedule(false);
          },
        };
      },
      props: {
        handleDOMEvents: {
          focus: () => {
            this.schedule(false);
            return false;
          },
          blur: () => {
            this.schedule(false);
            return false;
          },
          compositionstart: () => {
            this.hide();
            return false;
          },
          compositionend: () => {
            this.schedule(false);
            return false;
          },
        },
      },
    });
  }
}

export const caret = new CaretManager();

// Where the browser itself would draw the caret: this respects line-wrap
// affinity exactly. Empty lines have no rect, so callers fall back to
// ProseMirror's coordsAtPos.
function nativeCaretRect(view: EditorView) {
  const selection = (view.root as Document).getSelection?.() ?? document.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed || !selection.focusNode) return null;
  if (!view.dom.contains(selection.focusNode)) return null;
  const range = document.createRange();
  range.setStart(selection.focusNode, selection.focusOffset);
  range.collapse(true);
  const rects = range.getClientRects();
  const rect = rects[rects.length - 1];
  return rect && rect.height > 0 ? rect : null;
}
