# dsh-markdown-outline — Markdown preview for the Session

A DSH Web bundle that turns Markdown files into a **Session View** beside the
Conversation: every plan and Markdown file the Session has produced or opened
is listed on the left, and the selected document renders on the right.

## What it does

- **Claims Markdown files, then hands them to the view.** Registers an
  `extension`-band right-Sidebar tab type for `dsh-resource://file/session/…`
  addresses ending in `.md`, `.markdown`, `.mdown`, or `.mdx`, and for
  `dsh-resource://plan/…` plan resources. Opening one from a Chat file link, a
  tool result, a file tree, a deliverable card, or a plan card does not open a
  reader beside the chat: the transient tab hands the document to the Session
  View, selects it there, and closes itself.
- **A Session View, beside Conversation.** `conversation.view` adds a
  **Markdown 预览** tab to the Session's view row (Conversation, Trajectory,
  Context, Team, …). The view lists this Session's plans and Markdown files,
  flat and with no workspace level, each expandable into its headings (`H1`–`H6`,
  including setext headings). Plans show their title once the plan resource has
  been read.
- **Document on the right.** Selecting a file or heading renders its Markdown
  (ATX and setext headings, paragraphs with CommonMark soft and hard breaks,
  fenced and indented code with a copy control, nested ordered/unordered and
  task lists, tables with alignment, blockquotes, rules, inline code, emphasis,
  strikethrough, links, autolinks, images through the authenticated `/api/file`
  route, and a leading YAML frontmatter block). Heading clicks scroll to the
  source line; relative file links select the target file in the same view.
- **Plans are Markdown too.** A plan resource is read through the registered
  plan provider, so a submitted plan renders exactly like a file, with its title
  and headings in the tree.
- **Latest content.** Opens read the file through `ctx.remote.workspaceFiles` in
  pages until EOF (bounded at 4 MiB / 40 pages) and record the file's version.
  The standard `useResource('file')` hook reports the version the Sidebar keeps
  live, so a version change re-reads the document while it is open; a page read
  that meets a newer version restarts.
- **Per-Session memory.** Each Session keeps its own opened-document list and
  selection; the view shows only that Session's documents.

## Limitations

- The view is a reader: it does not edit files.
- The list covers documents this plugin has seen opened or redirected, not every
  Markdown file in the workspace (use the files tab for the directory tree).
- A plan or file that is opened outside this plugin's tab type (for example an
  absolute `dsh-resource://file/absolute/…` address) is not claimed.
- The renderer is a self-contained Markdown subset; reference-style links,
  footnotes, raw HTML blocks, math, and syntax highlighting render as plain text.
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
| `client.js` | Browser half: tab type, Session view, document list, Markdown renderer, and plan support. React is the only module it requests. |
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

