// Adds loading="lazy" and decoding="async" to post images so offscreen
// figures don't compete with the first paint. Handles plain <img> elements
// (Markdown images), raw <img> tags written inline in .md posts, and <img>
// JSX (MDX), skipping any that set these explicitly.

const DEFAULTS = { loading: 'lazy', decoding: 'async' };

function walk(node, visit) {
  visit(node);
  if (Array.isArray(node.children)) for (const child of node.children) walk(child, visit);
}

export default function rehypeLazyImages() {
  return (tree) => {
    walk(tree, (node) => {
      if (node.type === 'element' && node.tagName === 'img') {
        node.properties ??= {};
        for (const [key, value] of Object.entries(DEFAULTS)) node.properties[key] ??= value;
      } else if (node.type === 'raw' && node.value.includes('<img')) {
        node.value = node.value.replace(/<img\b[^>]*>/gi, (tag) => {
          let next = tag;
          for (const [key, value] of Object.entries(DEFAULTS)) {
            if (!new RegExp(`\\s${key}\\s*=`, 'i').test(next)) next = next.replace(/^<img\b/i, `<img ${key}="${value}"`);
          }
          return next;
        });
      } else if ((node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') && node.name === 'img') {
        for (const [key, value] of Object.entries(DEFAULTS)) {
          if (!node.attributes.some((attr) => attr.name === key)) {
            node.attributes.push({ type: 'mdxJsxAttribute', name: key, value });
          }
        }
      }
    });
  };
}
