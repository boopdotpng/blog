/**
 * Click-to-expand fullscreen viewer for static diagrams and oversized images.
 *
 * Diagrams opt in with `data-zoomable` on their `.dgm` root and get a small
 * expand button; clicking clones the diagram's vector SVG into a fullscreen
 * overlay where it scales crisply to fit the viewport. Standalone article
 * images get the same treatment automatically (handy for diagrams that are
 * too wide for the prose column). One overlay is shared by both.
 */

const EXPAND_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>';

class ZoomOverlay {
  private root: HTMLDivElement;
  private content: HTMLDivElement;
  private closeBtn: HTMLButtonElement;
  private lastFocus: Element | null = null;
  private bodyOverflow = '';

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'dgm-zoom-overlay';
    this.root.setAttribute('hidden', '');
    this.root.innerHTML = `
      <div class="dgm-zoom-overlay__backdrop" data-action="close"></div>
      <div class="dgm-zoom-overlay__panel" role="dialog" aria-modal="true" aria-label="Expanded view">
        <button class="dgm-zoom-overlay__close" type="button" data-action="close" aria-label="Close">×</button>
        <div class="dgm-zoom-overlay__content"></div>
      </div>`;
    document.body.append(this.root);

    this.content = this.root.querySelector('.dgm-zoom-overlay__content') as HTMLDivElement;
    this.closeBtn = this.root.querySelector('.dgm-zoom-overlay__close') as HTMLButtonElement;

    this.root.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-action="close"]')) this.close();
    });
    window.addEventListener('keydown', (event) => {
      if (this.root.hasAttribute('hidden')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close();
      }
    });
  }

  open(node: Node, label: string, trigger: Element | null) {
    this.lastFocus = trigger;
    this.content.replaceChildren(node);
    this.root.querySelector('.dgm-zoom-overlay__panel')?.setAttribute('aria-label', label);
    this.bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    this.root.removeAttribute('hidden');
    this.closeBtn.focus();
  }

  close() {
    if (this.root.hasAttribute('hidden')) return;
    this.root.setAttribute('hidden', '');
    document.body.style.overflow = this.bodyOverflow;
    this.content.replaceChildren();
    if (this.lastFocus instanceof HTMLElement) this.lastFocus.focus();
  }
}

let overlay: ZoomOverlay | null = null;
const ensureOverlay = () => (overlay ??= new ZoomOverlay());

function addDiagramExpand(dgm: HTMLElement) {
  if (!dgm.querySelector('svg')) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dgm-expand';
  btn.setAttribute('aria-label', 'Expand diagram to fullscreen');
  btn.innerHTML = EXPAND_ICON;

  btn.addEventListener('click', () => {
    // clone the whole diagram so the class chain (and thus its CSS) comes with
    // it, then strip the chrome that doesn't belong in the fullscreen view
    const clone = dgm.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll(
        // drop chrome + any frozen animation markers — the clone is static
        '.dgm-expand, .dgm-caption, .dgm-hint, .dgm-toolbar, .dgm-pipe-token, .dgm-marker, .dgm-fan',
      )
      .forEach((node) => node.remove());
    clone.removeAttribute('data-zoomable');
    clone.classList.add('is-zoomed');
    const label = dgm.querySelector('svg')?.getAttribute('aria-label') ?? 'Expanded diagram';
    ensureOverlay().open(clone, label, btn);
  });

  dgm.append(btn);
}

function addImageZoom(img: HTMLImageElement) {
  img.classList.add('md-zoomable');
  if (!img.title) img.title = 'Click to expand';
  img.addEventListener('click', () => {
    const big = new Image();
    big.src = img.currentSrc || img.src;
    big.alt = img.alt;
    big.className = 'dgm-zoom-img';
    ensureOverlay().open(big, img.alt || 'Expanded image', img);
  });
}

function init() {
  document.querySelectorAll<HTMLElement>('.dgm[data-zoomable]').forEach(addDiagramExpand);
  document.querySelectorAll<HTMLImageElement>('.markdown-body img').forEach((img) => {
    if (img.closest('.md-gallery') || img.closest('.dgm-zoom-overlay')) return;
    addImageZoom(img);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
