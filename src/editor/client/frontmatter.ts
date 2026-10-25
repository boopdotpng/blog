import { isScalar, parseDocument, Scalar, type Document } from 'yaml';

// Edits YAML frontmatter in place: untouched keys keep their exact quoting,
// order and comments, and an unedited block is written back byte-for-byte.

// Strings that YAML (or Astro's loader) might read as something else.
const NEEDS_QUOTES = /^\d{4}-\d{2}-\d{2}$|^(true|false|yes|no|null|~)$|^[\d.+-]+$/i;

export class Frontmatter {
  private doc: Document;
  changed = false;

  constructor(private original: string | null) {
    this.doc = parseDocument(original ?? '');
  }

  get<T = unknown>(key: string): T | undefined {
    return this.doc.get(key) as T | undefined;
  }

  has(key: string) {
    return this.doc.has(key);
  }

  set(key: string, value: string | number | boolean) {
    const node = this.doc.get(key, true);
    if (isScalar(node)) {
      if (node.value === value) return;
      node.value = value;
      if (typeof value === 'string' && node.type === 'PLAIN' && NEEDS_QUOTES.test(value)) node.type = 'QUOTE_DOUBLE';
    } else {
      const scalar = new Scalar(value);
      if (typeof value === 'string') scalar.type = 'QUOTE_DOUBLE';
      this.doc.set(key, scalar);
    }
    this.changed = true;
  }

  delete(key: string) {
    if (!this.doc.has(key)) return;
    this.doc.delete(key);
    this.changed = true;
  }

  entries(): [string, unknown][] {
    const json = (this.doc.toJS() ?? {}) as Record<string, unknown>;
    return Object.entries(json);
  }

  // `head` is the original `---\n...\n---\n` block, reused when unchanged.
  render(head: string) {
    if (!this.changed && head) return head;
    return `---\n${this.doc.toString({ lineWidth: 0 })}---\n`;
  }
}
