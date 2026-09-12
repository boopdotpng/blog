// Converts ((sidenote text)) in markdown into Tufte-style sidenotes.
// Uses the checkbox hack for mobile toggle — pure CSS, no JS.
// Inline Markdown (code, emphasis, links, etc.) is preserved inside notes.
//
// Usage in markdown:
//   Some text ((This appears as a numbered note in the right margin.)) and more text.

export default function remarkSidenote() {
  return (tree) => {
    let counter = 0;

    function walk(node) {
      if (!Array.isArray(node.children) || node.type === 'sidenoteElement') return;
      const children = node.children;

      for (let start = 0; start < children.length; start++) {
        const first = children[start];
        if (first.type !== 'text') continue;
        const open = first.value.indexOf('((');
        if (open === -1) continue;

        // Delimiters may surround several inline nodes, such as inlineCode.
        let end = start;
        let close = -1;
        for (; end < children.length; end++) {
          const candidate = children[end];
          if (candidate.type !== 'text') continue;
          close = candidate.value.indexOf('))', end === start ? open + 2 : 0);
          if (close !== -1) break;
        }
        if (close === -1) continue;

        const last = children[end];
        const noteChildren = end === start
          ? [text(first.value.slice(open + 2, close))]
          : [text(first.value.slice(open + 2)), ...children.slice(start + 1, end), text(last.value.slice(0, close))];
        const id = `sn-${++counter}`;
        // Structured elements work in both Markdown and MDX; raw HTML nodes
        // are discarded by the MDX compiler.
        const replacement = [
          text(first.value.slice(0, open)),
          element('label', { htmlFor: id, className: ['sidenote-number'] }),
          element('input', { type: 'checkbox', id, className: ['sidenote-toggle'] }),
          element('span', { className: ['sidenote'] }, noteChildren),
          text(last.value.slice(close + 2)),
        ];
        children.splice(start, end - start + 1, ...replacement);
        // Process the trailing text next, which may contain another note.
        start += replacement.length - 2;
      }

      for (const child of children) walk(child);
    }

    walk(tree);
  };
}

function text(value) {
  return { type: 'text', value };
}

function element(name, properties, children = []) {
  return {
    type: 'sidenoteElement',
    data: { hName: name, hProperties: properties },
    children,
  };
}
