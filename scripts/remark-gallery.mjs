function normalizePublicImageSrc(src) {
  const trimmed = String(src ?? '').trim();
  if (!trimmed) return '';

  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  let normalized = trimmed;
  if (normalized.startsWith('public/')) normalized = normalized.slice('public'.length);
  if (!normalized.startsWith('/')) normalized = `/${normalized}`;
  return normalized;
}

function parseGalleryLines(value) {
  const lines = String(value ?? '')
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  const images = [];
  for (const line of lines) {
    const [srcPart, ...altParts] = line.split('|');
    const src = normalizePublicImageSrc(srcPart);
    if (!src) continue;
    const alt = altParts.join('|').trim();
    images.push({ src, ...(alt ? { alt } : {}) });
  }
  return images;
}

function walk(node, visitor, parent = null) {
  if (!node || typeof node !== 'object') return;
  visitor(node, parent);

  const children = node.children;
  if (!Array.isArray(children)) return;
  for (const child of children) walk(child, visitor, node);
}

export default function remarkGallery() {
  return (tree) => {
    walk(tree, (node, parent) => {
      if (!parent || !Array.isArray(parent.children)) return;
      if (node.type !== 'code') return;
      const lang = String(node.lang ?? '').toLowerCase();
      if (lang !== 'gallery') return;

      const images = parseGalleryLines(node.value);
      if (images.length === 0) return;

      const encoded = encodeURIComponent(JSON.stringify(images));
      const html = `<div class="md-gallery" data-gallery-images="${encoded}"></div>`;

      const index = parent.children.indexOf(node);
      if (index === -1) return;
      parent.children.splice(index, 1, { type: 'html', value: html });
    });
  };
}

