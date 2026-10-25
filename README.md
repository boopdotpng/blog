# blog

this website (other than my blogs, obviously) was 100% written by Codex or Claude Code. I haven't had to make a single manual edit. 



## editor (dev only)

`bun dev`, then open `/editor`. It edits the files in `src/content/blog` directly and autosaves; it is not part of `astro build`.

- markdown shortcuts as you type: `#`, `-`, `1.`, `>`, ```` ```lang ````, `---`, `**bold**`, `*em*`, `` `code` ``, `~~strike~~`, `[text](url)`
- `((` sidenote · `$tex$` inline math · `$$` + enter display math · `/` for every block (callouts, tables, images, galleries, diagrams)
- paste or drop images to upload them to `public/images`
- `⌘K` link · `⌘⌥N` sidenote · `⌘⌥M` inline math · `⌘/` raw markdown · `⌘S` save
- `bun run test:editor` checks every post round-trips through the editor unchanged
