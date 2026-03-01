// Converts ((sidenote text)) in markdown into Tufte-style sidenotes.
// Uses the checkbox hack for mobile toggle — pure CSS, no JS.
//
// Usage in markdown:
//   Some text ((This appears as a numbered note in the right margin.)) and more text.

function walk(node, visitor, parent = null) {
  if (!node || typeof node !== 'object') return;
  visitor(node, parent);
  if (Array.isArray(node.children))
    for (const child of node.children) walk(child, visitor, node);
}

let counter = 0;

export default function remarkSidenote() {
  return (tree) => {
    counter = 0;
    walk(tree, (node, parent) => {
      if (node.type !== 'text') return;
      if (!node.value.includes('((')) return;
      if (!parent || !Array.isArray(parent.children)) return;

      const parts = splitSidenotes(node.value);
      if (parts.length <= 1) return;

      const idx = parent.children.indexOf(node);
      if (idx === -1) return;

      const newNodes = parts.map(part => {
        if (part.type === 'text') return { type: 'text', value: part.value };
        counter++;
        const id = `sn-${counter}`;
        return {
          type: 'html',
          value: `<label for="${id}" class="sidenote-number"></label>`
            + `<input type="checkbox" id="${id}" class="sidenote-toggle"/>`
            + `<span class="sidenote">${escapeHtml(part.value)}</span>`,
        };
      });

      parent.children.splice(idx, 1, ...newNodes);
    });
  };
}

function splitSidenotes(text) {
  const parts = [];
  let remaining = text;

  while (remaining.length > 0) {
    const open = remaining.indexOf('((');
    if (open === -1) {
      parts.push({ type: 'text', value: remaining });
      break;
    }
    const close = remaining.indexOf('))', open + 2);
    if (close === -1) {
      parts.push({ type: 'text', value: remaining });
      break;
    }

    if (open > 0) parts.push({ type: 'text', value: remaining.slice(0, open) });
    parts.push({ type: 'sidenote', value: remaining.slice(open + 2, close) });
    remaining = remaining.slice(close + 2);
  }

  return parts;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
