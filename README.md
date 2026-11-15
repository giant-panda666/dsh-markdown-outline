# dsh-markdown-outline — Markdown outline preview

A DSH Web bundle that claims `*.md` file addresses in the right Sidebar and
draws them as an outline tree plus the rendered document.

## What it does

- **Claims Markdown files.** Registers an `extension`-band right-Sidebar tab type
  for `dsh-resource://file/session/<sessionId>/…` addresses whose path ends in
  `.md`, `.markdown`, `.mdown`, or `.mdx`. Opening a Markdown link from a Chat
  row, a tool result, a file tree, or a deliverable opens this panel instead of
  the built-in document preview. Every other file type keeps its existing viewer.
- **Outline on the left.** The rail lists each file this type has opened, grouped
  as workspace → session → file → headings (`H1`–`H6`, including setext headings).
  A file stays listed after its tab closes, so it can be opened again from the
  outline. The tree is recorded per Sidebar Session; two sessions keep separate
  catalogs. Collapsing a workspace, session, or file is remembered in
  `localStorage` (`dsh.markdown-outline.ui.v1`), as is the rail's visibility.
- **Document on the right.** Clicking a file row opens or reveals its tab;
  clicking a heading scrolls the current document, or opens the other file with
  that source line as its navigation parameter. The rendered Markdown covers ATX
  and setext headings, paragraphs (CommonMark soft and hard breaks), fenced and
  indented code with a copy control, nested ordered/unordered and task lists,
  tables with alignment, blockquotes, rules, inline code, emphasis, strikethrough,
  links, autolinks, images served through the authenticated `/api/file` route,
  and a leading YAML frontmatter block as a key/value list. Relative links to
  other files open through the Sidebar; `#fragment` links scroll to a heading.
- **Latest content.** Opens read the file through `ctx.remote.workspaceFiles` in
  pages until EOF (bounded at 4 MiB / 40 pages) and record the file's version.
  The standard `useResource('file')` hook reports the version the Sidebar keeps
  live for the tab, so a version change re-reads the document while it is open,
  a page read that meets a newer version restarts, and reopening a tab compares
  the cached version before showing old text. A short "File updated" chip marks
  an automatic refresh. A manual reload button and the page refresh command
  re-read on demand.
- **Reading position** is remembered per file address, and survives a reload or
  switching to another file and back.

## Limitations

- The panel is a reader: it does not edit files.
- The renderer is a self-contained Markdown subset; reference-style links,
  footnotes, raw HTML blocks, math, and syntax highlighting render as plain text.
- The catalog lists files opened through this type, not every Markdown file in
  the workspace (use the `files` tab for the full directory tree).
- History is kept in memory per Sidebar Session; only files whose tabs are open
  are restored after a page reload.
- Reads stop at the configured Host page limits, 4 MiB, or 40 pages, and say so
  in the document header area.

## Install

The package is a DSH bundle: `dsh.bundle.patch` inserts one Loader row and
`dsh.client` serves the browser half. Install it from a checked-out directory
with **Plugins → Add plugin**, or from the published repository with the
package-manager spec the Host accepts (for example
`github:giant-panda666/dsh-markdown-outline`). Enabling the bundle requires a Host
restart only when the profile replaces an installed package under the same
name; a first install activates live.

The persisted tab kind stays `markdown-outline` on purpose, so Markdown tabs
opened before a package rename keep their body.

## Layout

| File | Role |
|---|---|
| `index.js` | Host half: a no-op `apply()`; the row exists so the Web carrier serves the client bundle. |
| `client.js` | Browser half: tab type, outline catalog, Markdown renderer, and panel component. React is the only module it requests. |
| `cordis.patch.yml` | Inserts the plugin row `markdown-outline`. |
| `locale/*.json` | Plugin Manager title, description, and detail page. |
| `icon.svg`, `docs/` | Display artwork and the single-image detail page. |

## Develop

`client.js` is a hand-written `window.__ModuleLoader__` factory (no build step).
A profile bundle installed from this directory is linked, so editing
`client.js` is delivered to an open page by the Client HMR poll.

```sh
npm test     # node --check client.js + the browser-free smoke test in test/
```

