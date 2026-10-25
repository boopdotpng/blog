import { render } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { EditorView } from 'prosemirror-view';
import { createEditor, replaceDoc } from './editor';
import { Frontmatter } from './frontmatter';
import { documentStats, parseBody, serializeBody, splitFrontmatter, type Origin } from './markdown';
import type { EditorContext } from './nodeviews';

// ── api ─────────────────────────────────────────────────────

interface PostSummary { slug: string; ext: 'md' | 'mdx'; title: string; pubDate: string; published: boolean; cat: string; mtime: number }
interface PostFile { slug: string; ext: 'md' | 'mdx'; source: string; mtime: number }
class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-blog-editor': '1' };
  if (typeof init.body === 'string') headers['content-type'] = 'application/json';
  const res = await fetch(`/__editor${path}`, { ...init, headers: { ...headers, ...(init.headers as any) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, res.status);
  return data as T;
}

const CATEGORIES = ['gpu', 'ml', 'hardware', 'tenstorrent', 'bio', 'misc'];
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const WORDS_PER_MINUTE = 220;

// Consulted before Vite reloads the page (see main.ts).
export const reloadGuard = {
  lastSave: 0,
  dirty: () => false,
  shouldBlock() {
    return Date.now() - this.lastSave < 4000 || this.dirty();
  },
};

const today = () => new Date().toLocaleDateString('en-CA');
const slugify = (title: string) => title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const go = (search: string) => {
  location.href = `/editor${search}`;
};

function displayDate(iso: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  return new Date(+match[1], +match[2] - 1, +match[3]).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }).toLowerCase();
}

// ── post list ───────────────────────────────────────────────

function PostList() {
  const [posts, setPosts] = useState<PostSummary[] | null>(null);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);

  useEffect(() => {
    document.title = 'editor · posts';
    api<PostSummary[]>('/posts').then(setPosts, (e) => setError(e.message));
  }, []);

  const effectiveSlug = slugTouched ? slug : slugify(title);
  const sorted = useMemo(() => [...(posts ?? [])].sort((a, b) => b.pubDate.localeCompare(a.pubDate)), [posts]);

  async function create(event: Event) {
    event.preventDefault();
    if (!SLUG.test(effectiveSlug)) return setError('slugs are lowercase letters, digits and dashes');
    const source = [
      '---',
      'readingTimeMinutes: 5',
      `title: ${JSON.stringify(title.trim() || 'untitled')}`,
      `pubDate: "${today()}"`,
      'published: false',
      'cat: misc',
      '---',
      '',
      '',
    ].join('\n');
    try {
      await api('/post', { method: 'PUT', body: JSON.stringify({ create: true, slug: effectiveSlug, ext: 'mdx', source }) });
      go(`?slug=${effectiveSlug}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div class="ed-list">
      <h1 class="ed-list-title">posts</h1>
      <form class="ed-new" onSubmit={create}>
        <input
          class="ed-new-title"
          placeholder="new post title…"
          value={title}
          onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
          autoFocus
        />
        <div class="ed-new-row">
          <label class="ed-new-slug">
            /blog/
            <input
              value={effectiveSlug}
              placeholder="slug"
              spellcheck={false}
              onInput={(e) => {
                setSlugTouched(true);
                setSlug((e.target as HTMLInputElement).value);
              }}
            />
          </label>
          <button type="submit" class="ed-button is-primary" disabled={!title.trim()}>create draft</button>
        </div>
      </form>
      {error && <p class="ed-error">{error}</p>}
      {!posts && !error && <p class="ed-faint">loading…</p>}
      <ul class="ed-posts">
        {sorted.map((post) => (
          <li key={post.slug}>
            <a class="ed-post" href={`/editor?slug=${post.slug}`} target="_self">
              <span class="ed-post-dot" style={`background: var(--cat-${post.cat}, var(--cat-misc))`} />
              <span class="ed-post-title">{post.title}</span>
              {!post.published && <span class="ed-badge">draft</span>}
              <span class="ed-post-meta">{post.pubDate} · .{post.ext}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── editor screen ───────────────────────────────────────────

type Status =
  | { kind: 'saved' }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'conflict'; message: string }
  | { kind: 'error'; message: string };

function AutoTextarea(props: { class: string; value: string; placeholder: string; onInput: (value: string) => void; onEnter?: () => void; maxLength?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [props.value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      class={props.class}
      value={props.value}
      placeholder={props.placeholder}
      spellcheck
      onInput={(e) => props.onInput((e.target as HTMLTextAreaElement).value.replace(/\n/g, ' '))}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || (e.key === 'ArrowDown' && ref.current!.selectionStart === ref.current!.value.length)) {
          e.preventDefault();
          props.onEnter?.();
        }
      }}
    />
  );
}

function EditorScreen({ slug: initialSlug }: { slug: string }) {
  const [file, setFile] = useState<PostFile | null>(null);
  const [components, setComponents] = useState<string[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<PostFile>(`/post?slug=${encodeURIComponent(initialSlug)}`).then(setFile, (e) => setError(e.message));
    api<{ name: string }[]>('/components').then((list) => setComponents(list.map((c) => c.name)), () => setComponents([]));
  }, [initialSlug]);

  if (error) {
    return (
      <div class="ed-list">
        <p class="ed-error">{error}</p>
        <a href="/editor" target="_self">← all posts</a>
      </div>
    );
  }
  if (!file || !components) return <p class="ed-faint ed-loading">loading…</p>;
  return <PostEditor file={file} components={components} />;
}

function PostEditor({ file, components }: { file: PostFile; components: string[] }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Everything describing the file on disk lives in refs; React state is
  // just what the chrome needs to render.
  const disk = useRef({ slug: file.slug, ext: file.ext, mtime: file.mtime, source: file.source });
  const doc = useRef<{ fm: Frontmatter; head: string; origin: Origin }>(null as any);
  const extRef = useRef(file.ext);
  const slugRef = useRef(file.slug);
  const saving = useRef<Promise<void> | null>(null);
  const saveTimer = useRef(0);

  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);
  const [status, setStatus] = useState<Status>({ kind: 'saved' });
  const [words, setWords] = useState(0);
  const [settings, setSettings] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  function parseFile(text: string, ext: 'md' | 'mdx') {
    const { head, yaml, body } = splitFrontmatter(text);
    const { doc: pmDoc, origin } = parseBody(body, ext === 'mdx');
    doc.current = { fm: new Frontmatter(yaml), head, origin };
    return pmDoc;
  }

  const buildSource = useCallback(() => {
    const view = viewRef.current!;
    const { fm, head, origin } = doc.current;
    const stats = documentStats(view.state.doc);
    // KaTeX CSS is only loaded for posts that opt in.
    if (stats.math && fm.get('useKatex') !== true) fm.set('useKatex', true);
    const mdx = extRef.current === 'mdx';
    const imports = mdx
      ? [...stats.components].filter((name) => components.includes(name)).map((name) => `import ${name} from '../../components/diagrams/${name}.tsx';`)
      : [];
    return fm.render(head) + serializeBody(view.state.doc, origin, mdx, imports);
  }, [components]);

  const isDirty = () =>
    buildSource() !== disk.current.source || slugRef.current !== disk.current.slug || extRef.current !== disk.current.ext;

  async function save(overwrite = false): Promise<void> {
    window.clearTimeout(saveTimer.current);
    if (saving.current) {
      await saving.current;
      return save(overwrite);
    }
    if (!isDirty()) {
      setStatus({ kind: 'saved' });
      return;
    }
    const text = buildSource();
    const body = {
      slug: slugRef.current,
      ext: extRef.current,
      from: disk.current.slug,
      source: text,
      baseMtime: overwrite ? null : disk.current.mtime,
    };
    setStatus({ kind: 'saving' });
    reloadGuard.lastSave = Date.now();
    saving.current = (async () => {
      try {
        const result = await api<{ slug: string; ext: 'md' | 'mdx'; mtime: number }>('/post', { method: 'PUT', body: JSON.stringify(body) });
        disk.current = { slug: result.slug, ext: result.ext, mtime: result.mtime, source: text };
        reloadGuard.lastSave = Date.now();
        if (location.search !== `?slug=${result.slug}`) history.replaceState(null, '', `/editor?slug=${result.slug}`);
        setStatus(isDirty() ? { kind: 'dirty' } : { kind: 'saved' });
      } catch (e) {
        const err = e as ApiError;
        setStatus(err.status === 409 ? { kind: 'conflict', message: err.message } : { kind: 'error', message: err.message });
      } finally {
        saving.current = null;
      }
    })();
    return saving.current;
  }

  function changed() {
    setStatus((s) => (s.kind === 'conflict' ? s : { kind: 'dirty' }));
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => save(), 900);
  }

  function setField(key: string, value: string | number | boolean | null) {
    const { fm } = doc.current;
    if (value === null || value === '') fm.delete(key);
    else fm.set(key, value);
    rerender();
    changed();
  }

  function loadText(text: string) {
    const pmDoc = parseFile(text, extRef.current);
    replaceDoc(viewRef.current!, pmDoc);
    setWords(documentStats(pmDoc).words);
    rerender();
  }

  // Mount ProseMirror once.
  useEffect(() => {
    const initial = parseFile(file.source, file.ext);
    const ctx: EditorContext = {
      async upload(upload) {
        const res = await fetch(`/__editor/upload?name=${encodeURIComponent(`${slugRef.current}-${upload.name}`)}`, {
          method: 'POST',
          headers: { 'x-blog-editor': '1' },
          body: upload,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        return data.src as string;
      },
      componentUrl(name) {
        if (components.includes(name)) return `/src/components/diagrams/${name}.tsx`;
        // Fall back to the post's own import path.
        for (const line of doc.current.origin.esm) {
          const match = new RegExp(`import\\s+${name}\\s+from\\s+['"]([^'"]+)['"]`).exec(line);
          if (match) return new URL(match[1], `${location.origin}/src/content/blog/`).pathname;
        }
        return null;
      },
      innerPlugins: () => [],
    };
    const view = createEditor({
      mount: mountRef.current!,
      doc: initial,
      ctx,
      mdx: () => extRef.current === 'mdx',
      components: () => components,
      onChange(view, tr) {
        if (!tr.docChanged) return;
        setWords(documentStats(view.state.doc).words);
        changed();
      },
      onSave: () => save(),
      onToggleSource: () => setSource((current) => (current === null ? buildSource() : null)),
    });
    viewRef.current = view;
    reloadGuard.dirty = isDirty;
    setWords(documentStats(initial).words);
    rerender();
    return () => view.destroy();
  }, []);

  // ⌘S anywhere, unsaved-changes guard, and pick up edits made elsewhere
  // (Obsidian, git) when the tab regains focus.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 's') {
        event.preventDefault();
        save();
      }
    };
    const onUnload = (event: BeforeUnloadEvent) => {
      if (viewRef.current && isDirty()) event.preventDefault();
    };
    const onFocus = async () => {
      if (saving.current) return;
      try {
        const remote = await api<PostFile>(`/post?slug=${encodeURIComponent(disk.current.slug)}`);
        if (remote.mtime === disk.current.mtime) return;
        if (isDirty()) {
          setStatus({ kind: 'conflict', message: 'the file changed on disk while you had unsaved edits' });
          return;
        }
        disk.current = { ...disk.current, mtime: remote.mtime, source: remote.source, ext: remote.ext };
        extRef.current = remote.ext;
        loadText(remote.source);
        setNotice('reloaded — the file changed on disk');
        window.setTimeout(() => setNotice(''), 3000);
      } catch {
        // Renamed or deleted elsewhere; saving will report it.
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const fm = doc.current?.fm;
  const title = (fm?.get<string>('title') ?? '').toString();
  const description = (fm?.get<string>('description') ?? '').toString();
  const pubDate = (fm?.get<string>('pubDate') ?? '').toString();
  const readingTime = Number(fm?.get('readingTimeMinutes') ?? 0);
  const published = fm?.get('published') !== false;

  useEffect(() => {
    document.title = `✎ ${title || slugRef.current}`;
  }, [title]);

  const focusBody = () => {
    const view = viewRef.current!;
    view.focus();
  };

  return (
    <>
      <TopBar
        slug={slugRef.current}
        ext={extRef.current}
        status={status}
        notice={notice}
        words={words}
        published={published}
        onSave={() => save()}
        onOverwrite={() => save(true)}
        onReload={async () => {
          const remote = await api<PostFile>(`/post?slug=${encodeURIComponent(disk.current.slug)}`);
          disk.current = { ...disk.current, mtime: remote.mtime, source: remote.source };
          loadText(remote.source);
          setStatus({ kind: 'saved' });
        }}
        onSource={() => setSource(source === null ? buildSource() : null)}
        onSettings={() => setSettings(!settings)}
      />

      <div class="centered-wrapper ed-page">
        <article class="post-plain markdown-body ed-article">
          <div class="post-meta">
            <input
              type="date"
              class="ed-date"
              value={pubDate}
              title="publish date"
              onInput={(e) => setField('pubDate', (e.target as HTMLInputElement).value)}
            />
            <span class="ed-date-label">{displayDate(pubDate)}</span>
            <span class="post-meta-sep">•</span>
            <span class="post-readtime">
              approx{' '}
              <input
                type="number"
                min={1}
                class="ed-readtime"
                value={readingTime || ''}
                onInput={(e) => {
                  const minutes = Math.round(Number((e.target as HTMLInputElement).value));
                  if (minutes > 0) setField('readingTimeMinutes', minutes);
                }}
              />
              m read
            </span>
            {!published && <span class="ed-badge">draft</span>}
          </div>
          <AutoTextarea class="post-title-main ed-title" value={title} placeholder="title" onInput={(v) => setField('title', v)} onEnter={focusBody} />
          <div class="post-subline">
            <AutoTextarea
              class="post-description ed-description"
              value={description}
              placeholder="description — shows in search results and link previews"
              onInput={(v) => setField('description', v)}
              onEnter={focusBody}
            />
            <SeoHints title={title} description={description} />
          </div>
          <div ref={mountRef} class="ed-body" />
        </article>
      </div>

      {settings && fm && (
        <Settings
          fm={fm}
          slug={slugRef.current}
          words={words}
          onField={setField}
          onSlug={(next) => {
            slugRef.current = next;
            rerender();
            save();
          }}
          onClose={() => setSettings(false)}
        />
      )}

      {source !== null && (
        <SourceView
          initial={source}
          onCancel={() => {
            setSource(null);
            viewRef.current?.focus();
          }}
          onApply={(text) => {
            setSource(null);
            loadText(text);
            changed();
            viewRef.current?.focus();
          }}
        />
      )}
    </>
  );
}

function SeoHints({ title, description }: { title: string; description: string }) {
  const hints: string[] = [];
  if (title.length > 60) hints.push(`title is ${title.length} chars; search results cut off around 60`);
  if (!description.trim()) hints.push('published posts need a description');
  else if (description.length < 50) hints.push(`description is short (${description.length}); 50–160 reads best in search`);
  else if (description.length > 160) hints.push(`description is ${description.length} chars; search shows ~160`);
  if (!hints.length) return null;
  return <p class="ed-hint">{hints.join(' · ')}</p>;
}

function TopBar(props: {
  slug: string; ext: string; status: Status; notice: string; words: number; published: boolean;
  onSave: () => void; onOverwrite: () => void; onReload: () => void; onSource: () => void; onSettings: () => void;
}) {
  const { status } = props;
  const label = {
    saved: 'saved',
    dirty: 'unsaved',
    saving: 'saving…',
    conflict: 'conflict',
    error: 'save failed',
  }[status.kind];
  return (
    <div class="ed-bar">
      <a href="/editor" target="_self" class="ed-bar-link" title="all posts">posts</a>
      <span class="ed-bar-file">{props.slug}.{props.ext}</span>
      <span class={`ed-status is-${status.kind}`} title={'message' in status ? status.message : ''}>
        <span class="ed-status-dot" />
        {props.notice || label}
      </span>
      {status.kind === 'conflict' && (
        <span class="ed-bar-conflict">
          <button type="button" class="ed-button" onClick={props.onReload}>load disk version</button>
          <button type="button" class="ed-button" onClick={props.onOverwrite}>overwrite</button>
        </span>
      )}
      <span class="ed-bar-words">{props.words.toLocaleString()} words</span>
      <button type="button" class="ed-button" onClick={props.onSource} title="edit raw markdown (⌘/)">markdown</button>
      <button type="button" class="ed-button" onClick={props.onSettings} title="frontmatter">settings</button>
      {props.published && (
        <a class="ed-button" href={`/blog/${props.slug}`} target="_blank" rel="noopener" title="open the rendered post">view ↗</a>
      )}
      <button type="button" class="ed-button is-primary" onClick={props.onSave} title="⌘S">save</button>
    </div>
  );
}

// Every frontmatter field, plus the slug.
const KNOWN = new Set(['title', 'description', 'pubDate', 'updatedDate', 'published', 'cat', 'readingTimeMinutes', 'useKatex', 'pinned', 'contents_table']);

function Settings(props: {
  fm: Frontmatter; slug: string; words: number;
  onField: (key: string, value: string | number | boolean | null) => void;
  onSlug: (slug: string) => void; onClose: () => void;
}) {
  const { fm, onField } = props;
  const [slug, setSlug] = useState(props.slug);
  const [problem, setProblem] = useState('');
  const cat = (fm.get<string>('cat') ?? 'misc').toString();
  const published = fm.get('published') !== false;
  const description = (fm.get<string>('description') ?? '').toString();
  const estimate = Math.max(1, Math.round(props.words / WORDS_PER_MINUTE));

  const commitSlug = () => {
    if (slug === props.slug) return;
    if (!SLUG.test(slug)) {
      setProblem('slugs are lowercase letters, digits and dashes');
      return;
    }
    setProblem('');
    props.onSlug(slug);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const check = (key: string, label: string, hint?: string) => (
    <label class="ed-check">
      <input type="checkbox" checked={fm.get(key) === true} onChange={(e) => onField(key, (e.target as HTMLInputElement).checked ? true : null)} />
      {label}
      {hint && <span class="ed-faint"> — {hint}</span>}
    </label>
  );

  return (
    <aside class="ed-drawer" aria-label="post settings">
      <div class="ed-drawer-head">
        <span>settings</span>
        <button type="button" class="ed-button" onClick={props.onClose}>close</button>
      </div>

      <label class="ed-field">
        <span>slug</span>
        <div class="ed-inline">
          <span class="ed-faint">/blog/</span>
          <input
            value={slug}
            spellcheck={false}
            onInput={(e) => setSlug((e.target as HTMLInputElement).value)}
            onBlur={commitSlug}
            onKeyDown={(e) => e.key === 'Enter' && commitSlug()}
          />
        </div>
        {problem && <span class="ed-error">{problem}</span>}
      </label>

      <label class="ed-check">
        <input
          type="checkbox"
          checked={published}
          onChange={(e) => onField('published', (e.target as HTMLInputElement).checked)}
        />
        published
        {published && !description.trim() && <span class="ed-error"> — needs a description</span>}
      </label>

      <label class="ed-field">
        <span>category</span>
        <div class="ed-cats">
          {[...new Set([...CATEGORIES, cat])].map((name) => (
            <button
              type="button"
              class={`ed-cat${name === cat ? ' is-active' : ''}`}
              onClick={() => onField('cat', name)}
            >
              <span class="ed-post-dot" style={`background: var(--cat-${name}, var(--cat-misc))`} />
              {name}
            </button>
          ))}
        </div>
      </label>

      <label class="ed-field">
        <span>updated</span>
        <div class="ed-inline">
          <input
            type="date"
            value={(fm.get<string>('updatedDate') ?? '').toString()}
            onInput={(e) => onField('updatedDate', (e.target as HTMLInputElement).value || null)}
          />
          <button type="button" class="ed-button" onClick={() => onField('updatedDate', today())}>today</button>
          {fm.has('updatedDate') && <button type="button" class="ed-button" onClick={() => onField('updatedDate', null)}>clear</button>}
        </div>
      </label>

      <label class="ed-field">
        <span>reading time</span>
        <div class="ed-inline">
          <input
            type="number"
            min={1}
            value={Number(fm.get('readingTimeMinutes') ?? 0) || ''}
            onInput={(e) => {
              const minutes = Math.round(Number((e.target as HTMLInputElement).value));
              if (minutes > 0) onField('readingTimeMinutes', minutes);
            }}
          />
          <span class="ed-faint">min</span>
          <button type="button" class="ed-button" onClick={() => onField('readingTimeMinutes', estimate)} title={`${props.words} words at ${WORDS_PER_MINUTE} wpm`}>
            use estimate ({estimate}m)
          </button>
        </div>
      </label>

      {check('useKatex', 'katex', 'set automatically when the post has math')}
      {check('pinned', 'pinned')}
      {check('contents_table', 'contents table')}

      {fm.entries().some(([key]) => !KNOWN.has(key)) && (
        <div class="ed-field">
          <span>other fields</span>
          {fm.entries().filter(([key]) => !KNOWN.has(key)).map(([key, value]) => (
            <code class="ed-faint">{key}: {JSON.stringify(value)}</code>
          ))}
        </div>
      )}
    </aside>
  );
}

function SourceView(props: { initial: string; onApply: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(props.initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div class="ed-source" onKeyDown={(e) => {
      if (e.key === 'Escape') props.onCancel();
      if ((e.metaKey || e.ctrlKey) && (e.key === '/' || e.key === 'Enter')) {
        e.preventDefault();
        props.onApply(text);
      }
    }}>
      <div class="ed-source-bar">
        <span>markdown source</span>
        <span class="ed-faint">⌘/ or ⌘↵ to apply · esc to cancel</span>
        <button type="button" class="ed-button" onClick={props.onCancel}>cancel</button>
        <button type="button" class="ed-button is-primary" onClick={() => props.onApply(text)} disabled={text === props.initial}>apply</button>
      </div>
      <textarea ref={ref} class="ed-source-text" value={text} spellcheck={false} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
    </div>
  );
}

export function mount(root: HTMLElement) {
  const slug = new URLSearchParams(location.search).get('slug');
  render(slug ? <EditorScreen slug={slug} /> : <PostList />, root);
}

