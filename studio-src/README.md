# The Studio: source code

The Studio (`/studio/` on the blog) is a small app that edits the blog through GitHub's API.
GitHub Pages only serves files, so the app is built here and the result is committed to
`studio/app/`. To use the Studio you don't need any of this; it's only for changing the app itself.

## Build

```bash
cd studio-src
npm install        # once
npm run build      # writes ../studio/app/
npm run watch      # rebuilds on every change while you work
```

Then commit `studio-src/` and `studio/` together. To try it locally, serve the built site
(`bundle exec jekyll serve`) and open http://localhost:4000/studio/.

## How it works

- **Sign-in:** a fine-grained GitHub access key limited to this repository (Contents: read and write),
  kept in `localStorage` ("Remember me") or `sessionStorage`. The page has a strict Content Security
  Policy: scripts only from this site, network requests only to `api.github.com`.
- **Loading:** `store.js` reads the branch head, the file tree and every post and `_data/topics.yml`
  through the Git Data API (only files that changed are fetched again).
- **Saving:** `github.js` writes each change as one commit (blobs → tree → commit → move the branch,
  never forced). If a file it's about to change was edited on GitHub after the Studio loaded it,
  the save stops with a message instead of overwriting.
- **Publishing:** after a save, `publish.js` watches the public GitHub Pages deployments and says
  when the change is live.
- **Posts** are Markdown with front matter, as before. `content.js` reads and writes them; unknown
  front matter keys are kept.
- **The editor** (`editor/`) is [Tiptap](https://tiptap.dev/) with its Markdown extension, plus:
  equations (`$$…$$`, rendered with KaTeX, loaded only when needed), escaping so typed text never turns
  into Markdown by accident (`editor.js`), and a tidy-up of the saved Markdown (`tidyMarkdown` in
  `content.js`). Posts using HTML, footnotes, Liquid or `{:…}` attributes open as plain Markdown so
  nothing is lost.
- **The network** reuses the blog's own engine (`assets/js/network.js`, `BlogNetwork.mount`), in
  edit mode, with the Studio deciding what each connection changes (`views/network.js`, `links.js`).
- **Subjects** live in `_data/topics.yml`, each with a page in `topics/`. Colors are checked for
  contrast in both themes (`colors.js`); `assets/css/topics.css` turns them into CSS for the blog.

```
src/
  main.js        start-up, sign-in, the page router, the account menu
  router.js      the #/… addresses
  config.js      the repository, the site address, reserved names, color swatches
  github.js      GitHub API calls and commits
  store.js       the loaded posts and subjects, saving
  content.js     reading and writing posts and topics.yml
  links.js       how posts and subjects point at each other
  colors.js      contrast and color distance
  autosave.js    backups of unsaved writing on this device
  publish.js     "your change is live" notifications
  ui.js          element builder, icons, toasts, dialogs
  editor/        the visual editor, its toolbar and equations
  views/         sign-in, posts, write, network, subjects
build.mjs        esbuild, plus copying KaTeX's stylesheet and fonts, plus the license list
```

`studio/index.html` (the page), `studio/studio.css` (the styles) and `studio/theme-init.js` are
served as they are; the page also uses the blog's `main.css`, `topics.css`, `theme.js` and `network.js`.
