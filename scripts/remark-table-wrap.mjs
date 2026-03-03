function wrapTables(node) {
  if (!node || typeof node !== 'object') return;

  const children = node.children;
  if (!Array.isArray(children)) return;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child?.type === 'table') {
      children.splice(
        i,
        1,
        { type: 'html', value: '<div class="md-table-wrap">' },
        child,
        { type: 'html', value: '</div>' },
      );
      i += 2;
      continue;
    }

    wrapTables(child);
  }
}

export default function remarkTableWrap() {
  return (tree) => {
    wrapTables(tree);
  };
}
