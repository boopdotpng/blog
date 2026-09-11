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

export default function remarkSidenote() {
  return (tree) => {
    let counter = 0;
    walk(tree, (node, parent) => {
      if (node.type !== 'text') return;
      if (!node.value.includes('((')) return;
      if (!parent || !Array.isArray(parent.children)) return;

      const parts = splitSidenotes(node.value);
      if (!parts.some(part => part.type === 'sidenote')) return;

      const idx = parent.children.indexOf(node);
      if (idx === -1) return;

      const newNodes = parts.flatMap(part => {
        if (part.type === 'text') return { type: 'text', value: part.value };
        counter++;
        const id = `sn-${counter}`;
        // Structured elements work in both Markdown and MDX; raw HTML nodes
        // are discarded by the MDX compiler.
        return [
          element('label', { htmlFor: id, className: ['sidenote-number'] }),
          element('input', { type: 'checkbox', id, className: ['sidenote-toggle'] }),
          element('span', { className: ['sidenote'] }, [{ type: 'text', value: part.value }]),
        ];
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

function element(name, properties, children = []) {
  return {
    type: 'sidenoteElement',
    data: { hName: name, hProperties: properties },
    children,
  };
}
