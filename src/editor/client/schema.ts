import { Schema, type NodeSpec, type MarkSpec } from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';

// Document model for the editor. Every Markdown construct the site's pipeline
// understands has a node here; anything else is kept verbatim as a raw node so
// a save never drops content.

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },

  paragraph: {
    group: 'block',
    content: 'inline*',
    parseDOM: [{ tag: 'p' }],
    toDOM: () => ['p', 0],
  },

  heading: {
    group: 'block',
    content: 'inline*',
    attrs: { level: { default: 2 } },
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
    toDOM: (node) => [`h${node.attrs.level}`, 0],
  },

  blockquote: {
    group: 'block',
    content: 'block+',
    defining: true,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM: () => ['blockquote', 0],
  },

  horizontal_rule: {
    group: 'block',
    parseDOM: [{ tag: 'hr' }],
    toDOM: () => ['hr'],
  },

  code_block: {
    group: 'block',
    content: 'text*',
    marks: '',
    code: true,
    defining: true,
    attrs: { lang: { default: '' }, meta: { default: null } },
    parseDOM: [{
      tag: 'pre',
      preserveWhitespace: 'full',
      getAttrs: (dom) => ({ lang: (dom as HTMLElement).dataset.lang ?? '' }),
    }],
    toDOM: (node) => ['pre', { 'data-lang': node.attrs.lang }, ['code', 0]],
  },

  bullet_list: {
    group: 'block',
    content: 'list_item+',
    attrs: { spread: { default: false } },
    parseDOM: [{ tag: 'ul' }],
    toDOM: () => ['ul', 0],
  },

  ordered_list: {
    group: 'block',
    content: 'list_item+',
    attrs: { start: { default: 1 }, spread: { default: false } },
    parseDOM: [{
      tag: 'ol',
      getAttrs: (dom) => ({ start: Number((dom as HTMLElement).getAttribute('start') ?? 1) }),
    }],
    toDOM: (node) => ['ol', node.attrs.start === 1 ? {} : { start: node.attrs.start }, 0],
  },

  list_item: {
    content: 'block+',
    attrs: { spread: { default: false }, checked: { default: null } },
    defining: true,
    parseDOM: [{ tag: 'li' }],
    toDOM: () => ['li', 0],
  },

  math_block: {
    group: 'block',
    atom: true,
    attrs: { tex: { default: '' } },
    parseDOM: [{ tag: 'div[data-math-block]', getAttrs: (dom) => ({ tex: (dom as HTMLElement).dataset.mathBlock }) }],
    toDOM: (node) => ['div', { 'data-math-block': node.attrs.tex }, node.attrs.tex],
  },

  image: {
    group: 'block',
    atom: true,
    draggable: true,
    // syntax: how the image was written, so it is written back the same way.
    attrs: { src: { default: '' }, alt: { default: '' }, title: { default: null }, width: { default: null }, syntax: { default: 'html' } },
    parseDOM: [{
      tag: 'img[src]',
      getAttrs: (dom) => {
        const img = dom as HTMLImageElement;
        return { src: img.getAttribute('src'), alt: img.getAttribute('alt') ?? '', title: img.getAttribute('title'), width: img.getAttribute('width') };
      },
    }],
    toDOM: (node) => ['img', { src: node.attrs.src, alt: node.attrs.alt, ...(node.attrs.title ? { title: node.attrs.title } : {}) }],
  },

  // An MDX component such as <NocGrid client:visible />, kept as source.
  component: {
    group: 'block',
    atom: true,
    draggable: true,
    attrs: { source: { default: '' }, name: { default: '' } },
    parseDOM: [{
      tag: 'div[data-component]',
      getAttrs: (dom) => ({ name: (dom as HTMLElement).dataset.component, source: (dom as HTMLElement).dataset.source }),
    }],
    toDOM: (node) => ['div', { 'data-component': node.attrs.name, 'data-source': node.attrs.source }, node.attrs.source],
  },

  // Raw HTML / JSX / anything the editor has no richer model for.
  raw_block: {
    group: 'block',
    atom: true,
    attrs: { source: { default: '' } },
    parseDOM: [{ tag: 'div[data-raw-block]', getAttrs: (dom) => ({ source: (dom as HTMLElement).dataset.rawBlock }) }],
    toDOM: (node) => ['div', { 'data-raw-block': node.attrs.source }, node.attrs.source],
  },

  ...tableNodes({
    tableGroup: 'block',
    cellContent: 'inline*',
    cellAttributes: {
      align: {
        default: null,
        getFromDOM: (dom) => (dom as HTMLElement).style.textAlign || null,
        setDOMAttr: (value, attrs) => {
          if (value) attrs.style = `${attrs.style ?? ''}text-align: ${value};`;
        },
      },
    },
  }),

  text: { group: 'inline' },

  hard_break: {
    group: 'inline',
    inline: true,
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM: () => ['br'],
  },

  math_inline: {
    group: 'inline',
    inline: true,
    atom: true,
    attrs: { tex: { default: '' } },
    parseDOM: [{ tag: 'span[data-math-inline]', getAttrs: (dom) => ({ tex: (dom as HTMLElement).dataset.mathInline }) }],
    toDOM: (node) => ['span', { 'data-math-inline': node.attrs.tex }, node.attrs.tex],
  },

  // ((sidenote)) — an inline node holding its own inline content, edited
  // through a nested editor rendered in the margin like the published post.
  sidenote: {
    group: 'inline',
    inline: true,
    atom: true,
    content: '(text | hard_break | math_inline | raw_inline)*',
    parseDOM: [{ tag: 'span[data-sidenote]' }],
    toDOM: () => ['span', { 'data-sidenote': '' }, 0],
  },

  raw_inline: {
    group: 'inline',
    inline: true,
    atom: true,
    attrs: { source: { default: '' } },
    parseDOM: [{ tag: 'span[data-raw-inline]', getAttrs: (dom) => ({ source: (dom as HTMLElement).dataset.rawInline }) }],
    toDOM: (node) => ['span', { 'data-raw-inline': node.attrs.source }, node.attrs.source],
  },
};

// Order is nesting order when serializing: link outermost, code innermost.
const marks: Record<string, MarkSpec> = {
  link: {
    attrs: { href: {}, title: { default: null } },
    inclusive: false,
    parseDOM: [{
      tag: 'a[href]',
      getAttrs: (dom) => ({ href: (dom as HTMLElement).getAttribute('href'), title: (dom as HTMLElement).getAttribute('title') }),
    }],
    toDOM: (mark) => ['a', { href: mark.attrs.href, title: mark.attrs.title ?? mark.attrs.href }, 0],
  },
  strong: {
    parseDOM: [
      { tag: 'strong' },
      { tag: 'b', getAttrs: (dom) => (dom as HTMLElement).style.fontWeight !== 'normal' && null },
      { style: 'font-weight=bold' },
      { style: 'font-weight', getAttrs: (value) => /^(bold(er)?|[6-9]\d{2,})$/.test(value as string) && null },
    ],
    toDOM: () => ['strong', 0],
  },
  em: {
    parseDOM: [{ tag: 'em' }, { tag: 'i' }, { style: 'font-style=italic' }],
    toDOM: () => ['em', 0],
  },
  strike: {
    parseDOM: [{ tag: 's' }, { tag: 'del' }, { style: 'text-decoration=line-through' }],
    toDOM: () => ['del', 0],
  },
  code: {
    code: true,
    parseDOM: [{ tag: 'code' }],
    toDOM: () => ['code', 0],
  },
};

export const schema = new Schema({ nodes, marks });
