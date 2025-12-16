type GalleryImage = {
  src: string;
  alt?: string;
};

function decodeGalleryImages(encoded: string | null): GalleryImage[] {
  if (!encoded) return [];
  try {
    const decoded = decodeURIComponent(encoded);
    const parsed = JSON.parse(decoded);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.src === 'string')
      .map((item) => ({ src: item.src, alt: typeof item.alt === 'string' ? item.alt : undefined }));
  } catch {
    return [];
  }
}

function clampIndex(index: number, length: number) {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

class FullscreenGallery {
  private root: HTMLDivElement;
  private img: HTMLImageElement;
  private caption: HTMLDivElement;
  private counter: HTMLDivElement;
  private closeBtn: HTMLButtonElement;
  private prevBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private images: GalleryImage[] = [];
  private index = 0;
  private lastFocus: Element | null = null;
  private bodyOverflow = '';

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'md-gallery-overlay';
    this.root.setAttribute('hidden', '');
    this.root.innerHTML = `
      <div class="md-gallery-overlay__backdrop" data-action="close"></div>
      <div class="md-gallery-overlay__panel" role="dialog" aria-modal="true" aria-label="Image gallery">
        <button class="md-gallery-overlay__close" type="button" data-action="close" aria-label="Close">×</button>
        <button class="md-gallery-overlay__nav md-gallery-overlay__nav--prev" type="button" data-action="prev" aria-label="Previous">‹</button>
        <button class="md-gallery-overlay__nav md-gallery-overlay__nav--next" type="button" data-action="next" aria-label="Next">›</button>
        <div class="md-gallery-overlay__content">
          <img class="md-gallery-overlay__img" alt="" />
          <div class="md-gallery-overlay__caption"></div>
          <div class="md-gallery-overlay__counter"></div>
        </div>
      </div>
    `;

    document.body.append(this.root);

    const img = this.root.querySelector('.md-gallery-overlay__img');
    const caption = this.root.querySelector('.md-gallery-overlay__caption');
    const counter = this.root.querySelector('.md-gallery-overlay__counter');
    const closeBtn = this.root.querySelector('.md-gallery-overlay__close');
    const prevBtn = this.root.querySelector('.md-gallery-overlay__nav--prev');
    const nextBtn = this.root.querySelector('.md-gallery-overlay__nav--next');

    if (!(img instanceof HTMLImageElement)) throw new Error('gallery overlay missing img');
    if (!(caption instanceof HTMLDivElement)) throw new Error('gallery overlay missing caption');
    if (!(counter instanceof HTMLDivElement)) throw new Error('gallery overlay missing counter');
    if (!(closeBtn instanceof HTMLButtonElement)) throw new Error('gallery overlay missing close');
    if (!(prevBtn instanceof HTMLButtonElement)) throw new Error('gallery overlay missing prev');
    if (!(nextBtn instanceof HTMLButtonElement)) throw new Error('gallery overlay missing next');

    this.img = img;
    this.caption = caption;
    this.counter = counter;
    this.closeBtn = closeBtn;
    this.prevBtn = prevBtn;
    this.nextBtn = nextBtn;

    this.root.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const actionTarget = target?.closest?.('[data-action]') as HTMLElement | null;
      const action = actionTarget?.getAttribute('data-action');
      if (!action) return;
      if (action === 'close') this.close();
      if (action === 'prev') this.prev();
      if (action === 'next') this.next();
    });

    window.addEventListener('keydown', (event) => {
      if (this.root.hasAttribute('hidden')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close();
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        this.prev();
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        this.next();
        return;
      }
    });
  }

  open(images: GalleryImage[], startIndex: number, trigger: Element | null) {
    if (images.length === 0) return;
    this.images = images;
    this.index = clampIndex(startIndex, images.length);
    this.lastFocus = trigger;

    this.bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    this.root.removeAttribute('hidden');
    this.render();
    this.closeBtn.focus();
  }

  close() {
    if (this.root.hasAttribute('hidden')) return;
    this.root.setAttribute('hidden', '');
    document.body.style.overflow = this.bodyOverflow;
    if (this.lastFocus instanceof HTMLElement) this.lastFocus.focus();
  }

  next() {
    if (this.images.length === 0) return;
    this.index = clampIndex(this.index + 1, this.images.length);
    this.render();
  }

  prev() {
    if (this.images.length === 0) return;
    this.index = clampIndex(this.index - 1, this.images.length);
    this.render();
  }

  render() {
    const img = this.images[this.index];
    this.img.src = img.src;
    this.img.alt = img.alt ?? '';
    this.caption.textContent = img.alt ?? '';
    this.counter.textContent = `${this.index + 1} / ${this.images.length}`;
  }
}

let overlay: FullscreenGallery | null = null;

function ensureOverlay() {
  overlay ??= new FullscreenGallery();
  return overlay;
}

function upgradeGallery(el: HTMLElement) {
  const images = decodeGalleryImages(el.getAttribute('data-gallery-images'));
  if (images.length === 0) return;

  const thumb = images[0];
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'md-gallery-thumb';
  btn.setAttribute('aria-label', `Open gallery (${images.length} images)`);

  const img = document.createElement('img');
  img.src = thumb.src;
  img.alt = thumb.alt ?? '';
  img.loading = 'lazy';
  img.decoding = 'async';

  const badge = document.createElement('span');
  badge.className = 'md-gallery-thumb__badge';
  badge.textContent = `${images.length}`;
  badge.setAttribute('aria-hidden', 'true');

  btn.append(img, badge);

  btn.addEventListener('click', () => {
    ensureOverlay().open(images, 0, btn);
  });

  el.replaceChildren(btn);
}

function initMarkdownGalleries() {
  const els = document.querySelectorAll<HTMLElement>('.md-gallery[data-gallery-images]');
  for (const el of els) upgradeGallery(el);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMarkdownGalleries, { once: true });
} else {
  initMarkdownGalleries();
}
