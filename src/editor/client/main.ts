import './editor.css';
import { mount, reloadGuard } from './app';

// Saving a post makes Astro full-reload every open page. This tab already
// has the content, so skip reloads caused by our own saves (and never drop
// unsaved edits); other tabs, e.g. a preview of the post, still reload.
if (import.meta.hot) {
  import.meta.hot.on('vite:beforeFullReload', (payload: { path?: string }) => {
    if (reloadGuard.shouldBlock()) payload.path = '/__blog-editor-stay.html';
  });
}

mount(document.getElementById('editor-app')!);
