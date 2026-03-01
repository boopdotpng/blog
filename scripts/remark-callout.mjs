// Detects blockquotes starting with "Update:", "tl;dr:", "Note:", "Warning:"
// and adds a callout class + wraps the label in a <strong>.

const CALLOUT_PATTERNS = [
  { re: /^update:/i, type: 'update' },
  { re: /^tl;?dr:/i, type: 'tldr' },
  { re: /^note:/i, type: 'note' },
  { re: /^warning:/i, type: 'warning' },
];

function walk(node, visitor, parent = null) {
  if (!node || typeof node !== 'object') return;
  visitor(node, parent);
  if (Array.isArray(node.children))
    for (const child of node.children) walk(child, visitor, node);
}

function getFirstText(node) {
  if (node.type === 'text') return node;
  if (Array.isArray(node.children))
    for (const child of node.children) {
      const found = getFirstText(child);
      if (found) return found;
    }
  return null;
}

export default function remarkCallout() {
  return (tree) => {
    walk(tree, (node) => {
      if (node.type !== 'blockquote') return;

      const textNode = getFirstText(node);
      if (!textNode) return;

      const text = textNode.value;
      for (const { re, type } of CALLOUT_PATTERNS) {
        const match = re.exec(text);
        if (!match) continue;

        // Add hProperties for the blockquote element
        node.data ??= {};
        node.data.hProperties ??= {};
        node.data.hProperties.className = `callout callout-${type}`;

        // Wrap the matched keyword in a <strong> with a class
        const label = text.slice(0, match[0].length);
        const rest = text.slice(match[0].length);
        const labelNode = {
          type: 'strong',
          data: { hProperties: { className: 'callout-label' } },
          children: [{ type: 'text', value: label }],
        };
        // Replace the text node's parent paragraph's children
        const parent = findParent(node, textNode);
        if (parent && Array.isArray(parent.children)) {
          const idx = parent.children.indexOf(textNode);
          if (idx !== -1) {
            parent.children.splice(idx, 1, labelNode, { type: 'text', value: rest });
          }
        }
        break;
      }
    });
  };
}

function findParent(root, target) {
  if (!root || typeof root !== 'object') return null;
  if (Array.isArray(root.children) && root.children.includes(target)) return root;
  if (Array.isArray(root.children))
    for (const child of root.children) {
      const found = findParent(child, target);
      if (found) return found;
    }
  return null;
}
