/**
 * Smoke test for the dsh-markdown-outline client module: runs the real factory in a
 * VM with a stub React, registers the plugin against a fake client context, and
 * renders the tab body once to catch wiring and parser errors without a browser.
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

const SAMPLE = `---
title: Demo
status: draft
---

# Overview

Intro paragraph with **bold**, \`code\`, and a [link](docs/other.md).

## Details

- one
- two
  - nested
- [x] done

### Deep heading

\`\`\`js
console.log('hi')
\`\`\`

| Name | Value |
| --- | ---: |
| a | 1 |

> quoted text

![diagram](img/diagram.png)
`

const SPECIAL = `Title One
=========

This is a soft
wrapped paragraph with snake_case_name inside.

Hard break here.  
after it.
`

const EMPTY = ''

const ADDRESS = 'dsh-resource://file/session/sess-1/docs/demo.md'

let captured
const sandbox = {
  window: {
    __ModuleLoader__: { load(spec) { captured = spec } },
    addEventListener() {},
    removeEventListener() {},
  },
  console,
  localStorage: { getItem: () => null, setItem: () => {} },
  document: { baseURI: 'http://127.0.0.1:54514/' },
  navigator: { clipboard: { writeText: async () => {} } },
  URL,
  URLSearchParams,
  setTimeout,
  clearTimeout,
  AbortController,
  Promise,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox)
if (captured === undefined || typeof captured.factory !== 'function') throw new Error('module loader factory not registered')

function createReact() {
  return {
    Fragment: Symbol.for('react.fragment'),
    createElement(type, props, ...children) {
      return { type, props: props === null || props === undefined ? {} : props, children: children.flat() }
    },
    useState(initial) { return [initial, () => {}] },
    useEffect(effect) { const cleanup = effect(); if (typeof cleanup === 'function') cleanup() },
    useMemo(factory) { return factory() },
    useCallback(fn) { return fn },
    useRef(value) { return { current: value } },
    useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot() },
  }
}

const React = createReact()
const mod = captured.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected module request: ${id}`)
})
if (typeof mod.apply !== 'function') throw new Error('plugin has no apply')

let tabDefinition
let componentRegistration
let titleRegistration
let pageRegistration
let entryRegistration
const opened = []
let openTabsSnapshot = []
const openTabsListeners = []
const disposeFns = []
const sessionOpens = []
const panelSelects = []
let readCalls = 0

const ctx = {
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposeFns.push(dispose)
    return () => {}
  },
  locale: {
    bind: () => (key) => key,
    register: () => () => {},
  },
  sidebarRightTabs: {
    register(definition) {
      tabDefinition = definition
      return () => {}
    },
  },
  sidebarRight: {
    openTabs: {
      getSnapshot: () => openTabsSnapshot,
      subscribe: (listener) => { openTabsListeners.push(listener); return () => {} },
    },
    openResource(...args) { opened.push(args) },
    isExpanded: () => true,
  },
  slots: {
    inject(name, callback) {
      const known = ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'main', 'sidebar.panellist']
      if (!known.includes(name)) throw new Error(`unexpected slot ${name}`)
      callback()
    },
    register(options, component) {
      if (options.name === 'sidebar.right.pane.tab.title') titleRegistration = { options, component }
      else if (options.name === 'main') pageRegistration = { options, component }
      else if (options.name === 'sidebar.panellist') entryRegistration = { options, component }
      else componentRegistration = { options, component }
      return () => {}
    },
  },
  uiWorkspace: {
    openSession(id) { sessionOpens.push(id) },
  },
  layout: {
    selectPanel(id) { panelSelects.push(id) },
  },
  remote: {
    workspaceFiles: {
      async read(sessionId, filePath, range) {
        readCalls += 1
        const text = filePath.endsWith('special.md') ? SPECIAL : filePath.endsWith('empty.md') ? EMPTY : SAMPLE
        const lines = text.split('\n')
        const offset = range === undefined || range.offset === undefined ? 1 : range.offset
        const page = lines.slice(offset - 1, offset - 1 + 5000).join('\n')
        return {
          ok: true,
          value: {
            absolutePath: `/ws/${filePath}`,
            version: 'v1',
            offset,
            text: page,
            lines: lines.length,
            eof: true,
          },
        }
      },
    },
  },
}

openTabsSnapshot = [{ sessionId: 'sess-1', tabId: 'tab-1', kind: 'markdown-outline', contentId: ADDRESS }]
mod.apply(ctx)

if (tabDefinition === undefined) throw new Error('tab type was not registered')
if (componentRegistration === undefined) throw new Error('tab body was not registered')
if (titleRegistration === undefined) throw new Error('tab title was not registered')
if (pageRegistration === undefined) throw new Error('outline page was not registered')
if (entryRegistration === undefined) throw new Error('sidebar entry was not registered')
if (tabDefinition.priority !== 'extension') throw new Error(`unexpected band ${tabDefinition.priority}`)
if (!tabDefinition.patterns.includes('*.md')) throw new Error('patterns do not claim *.md')
if (tabDefinition.canOpen('dsh-resource://file/session/sess-1/a/b.md') !== true) throw new Error('canOpen rejected a .md session address')
if (tabDefinition.canOpen('dsh-resource://file/session/sess-1/a/b.txt') !== false) throw new Error('canOpen accepted a non-markdown path')
if (tabDefinition.canOpen('dsh-resource://file/absolute/a/b.md') !== false) throw new Error('canOpen accepted an absolute address')
if (tabDefinition.title(ADDRESS) !== 'demo.md') throw new Error(`unexpected title ${tabDefinition.title(ADDRESS)}`)

// The catalog syncs from the open-tab inventory during apply and starts reading.
await new Promise((resolve) => setTimeout(resolve, 0))

const tab = {
  id: 'tab-1',
  kind: 'markdown-outline',
  title: 'demo.md',
  contentId: ADDRESS,
  visible: true,
  navigation: { address: ADDRESS, params: undefined, revision: 0 },
  signal: new AbortController().signal,
  actions: {
    openResource(...args) { opened.push(args) },
    openTab() {},
    close() {},
    bindCommands() { return () => {} },
  },
}
const props = {
  sessionId: 'sess-1',
  useTabInfo: () => ({ sidebar: { expanded: true, fullscreen: false }, panel: { id: 'pane-1', isFloating: false }, tab }),
  useResource: () => ({ status: 'live', value: { absolutePath: '/ws/docs/demo.md', version: 'v1', bytes: 512 } }),
  useWorkspaces: (selector) => selector({
    items: [{ workspaceId: 'w1', title: 'demo-workspace', path: '/ws', sessionIds: ['sess-1'] }],
  }),
  useSessions: (selector) => selector({ byId: { 'sess-1': { id: 'sess-1', displayTitle: 'Demo session' } } }),
  t: (key) => key,
}

// The tab body only hands the file to the outline page and closes itself.
const redirected = componentRegistration.component(props)
if (redirected !== null) throw new Error('the tab body should render nothing and redirect')
// The page then shows the file the redirect selected.
const rendered = pageRegistration.component(props)

function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') return
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return }
  if (typeof node !== 'object') return
  if (typeof node.type === 'function') {
    // Render function components the way React would, so their markup is visited.
    walk(node.type(node.props === undefined ? {} : node.props), visit)
    return
  }
  if (node.type === undefined || typeof node.type === 'symbol') {
    // A fragment (React.Fragment has no tag name).
    for (const child of node.children) walk(child, visit)
    walk(node.props.children, visit)
    return
  }
  if (typeof node.type !== 'string') throw new Error(`unexpected element type ${String(node.type)}`)
  visit(node)
  for (const child of node.children) walk(child, visit)
  walk(node.props.children, visit)
}

const collect = (root, predicate) => {
  const found = []
  const visit = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') return
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (typeof node !== 'object') return
    if (typeof node.type === 'function') { visit(node.type(node.props === undefined ? {} : node.props)); return }
    if (node.type === undefined) return
    if (predicate(node)) found.push(node)
    for (const child of node.children) visit(child)
    if (node.props.children !== undefined) visit(node.props.children)
  }
  visit(root)
  return found
}
const classes = new Set()
const texts = []
walk(rendered, (node) => {
  if (typeof node.type === 'string' && typeof node.props.className === 'string') {
    node.props.className.split(/\s+/).forEach((name) => classes.add(name))
  }
  for (const child of node.children) {
    if (typeof child === 'string' || typeof child === 'number') texts.push(String(child))
  }
})

for (const expected of ['mo-page', 'mo-page-doc', 'mo-head', 'mo-scroll', 'mo-md']) {
  if (!classes.has(expected)) throw new Error(`the document panel is missing .${expected}`)
}
const drawer = pageRegistration.component(props)
const drawerClasses = new Set()
const drawerTexts = []
walk(drawer, (node) => {
  if (typeof node.type === 'string' && typeof node.props.className === 'string') {
    node.props.className.split(/\s+/).forEach((name) => drawerClasses.add(name))
  }
  for (const child of node.children) if (typeof child === 'string') drawerTexts.push(child)
})
for (const expected of ['mo-page', 'mo-tree', 'mo-row-workspace', 'mo-row-session', 'mo-row-file', 'mo-row-heading']) {
  if (!drawerClasses.has(expected)) throw new Error(`the outline page is missing .${expected}`)
}
const drawerJoined = drawerTexts.join(' ')
for (const expected of ['demo-workspace', 'Demo session', 'demo.md']) {
  if (!drawerJoined.includes(expected)) throw new Error(`the outline page is missing ${JSON.stringify(expected)}: ${JSON.stringify(drawerTexts.slice(0, 20))}`)
}
const headingTexts = []
walk(rendered, (node) => {
  if (typeof node.type === 'string' && /^h[1-6]$/.test(node.type)) {
    headingTexts.push(node.children.filter((child) => typeof child === 'string').join(''))
  }
})
const joined = texts.join(' ')
for (const expected of ['Overview', 'Details', 'Deep heading']) {
  if (!joined.includes(expected) && !headingTexts.some((text) => text.includes(expected))) {
    throw new Error(`rendered output is missing ${JSON.stringify(expected)}; got ${JSON.stringify(texts.slice(0, 30))}`)
  }
}
if (readCalls === 0) throw new Error('the catalog never read the file')
const headingLines = collect(rendered, (node) => typeof node.type === 'string' && /^h[1-6]$/.test(node.type))
  .map((node) => node.props['data-md-line'])
if (headingLines.join(',') !== '6,10,17') throw new Error(`unexpected heading source lines: ${headingLines.join(',')}`)
if (!classes.has('mo-md-code') && !classes.has('mo-md-code-head')) throw new Error('code block was not rendered')
if (!classes.has('mo-md-frontmatter')) throw new Error('frontmatter block was not rendered')
if (!classes.has('mo-md-img')) throw new Error('image was not resolved')
if (!classes.has('mo-md-link')) throw new Error('inline link was not rendered')

// Simulate a tree interaction: a heading in another open file opens with a line.
openTabsSnapshot = [
  { sessionId: 'sess-1', tabId: 'tab-1', kind: 'markdown-outline', contentId: ADDRESS },
  { sessionId: 'sess-1', tabId: 'tab-2', kind: 'markdown-outline', contentId: 'dsh-resource://file/session/sess-1/docs/second.md' },
]
openTabsListeners.forEach((listener) => listener())
await new Promise((resolve) => setTimeout(resolve, 0))

const rerenderedDrawer = pageRegistration.component(props)
const fileRows = collect(rerenderedDrawer, (node) => typeof node.type === 'string' && node.props.className === 'mo-row mo-row-file')
if (fileRows.length !== 2) throw new Error(`expected two file rows, found ${fileRows.length}`)
const fileRowContainers = collect(rerenderedDrawer, (node) => typeof node.type === 'string' && node.props.className === 'mo-row mo-row-file')
const fileBodies = fileRowContainers.flatMap((row) => collect(row, (node) => node.type === 'button' && node.props.className === 'mo-rowbody'))
if (fileBodies.length !== 2) throw new Error(`expected two file open buttons, found ${fileBodies.length}`)
fileBodies[1].props.onClick()
const afterSelect = pageRegistration.component(props)
const pageClasses = new Set()
walk(afterSelect, (node) => {
  if (typeof node.type === 'string' && typeof node.props.className === 'string') node.props.className.split(/\s+/).forEach((name) => pageClasses.add(name))
})
if (!pageClasses.has('mo-page') || !pageClasses.has('mo-page-rail')) throw new Error('the outline page lost its tree rail')
if (!pageClasses.has('mo-page-doc') || !pageClasses.has('mo-md')) throw new Error('selecting a tree row did not show the document')
const docTitles = collect(afterSelect, (node) => typeof node.type === 'string' && node.props.className === 'mo-title')
  .map((node) => node.children.join(''))
if (!docTitles.some((title) => title.includes('second.md'))) throw new Error(`the document pane did not switch files: ${JSON.stringify(docTitles)}`)
const openCall = undefined

// The tab chip renders the markdown glyph before the captured title.
// The session row carries a back control that returns to its conversation.
const backButtons = collect(drawer, (node) => node.type === 'button' && node.props.title === 'action.backToSession')
if (backButtons.length === 0) throw new Error('the session row has no back-to-session control')
backButtons[0].props.onClick({ stopPropagation() {} })
if (!sessionOpens.includes('sess-1')) throw new Error(`back-to-session did not open the Session: ${JSON.stringify(sessionOpens)}`)
if (!panelSelects.includes('conversation')) throw new Error(`back-to-session did not select the conversation: ${JSON.stringify(panelSelects)}`)

const chip = titleRegistration.component({ useTabInfo: props.useTabInfo })
const chipText = (chip.children || []).filter((child) => typeof child === 'string')
if (!chipText.join('').includes('demo.md')) throw new Error(`title component did not include the tab title: ${JSON.stringify(chipText)}`)

// A newer version of the open file re-reads it (the live-refresh path).
const beforeReload = readCalls
const v2props = {
  ...props,
  useResource: () => ({ status: 'live', value: { absolutePath: '/ws/docs/demo.md', version: 'v2', bytes: 700 } }),
}
// Deep expansion runs the nested document component's effects, as React would.
walk(pageRegistration.component(v2props), () => {})
await new Promise((resolve) => setTimeout(resolve, 0))
if (readCalls <= beforeReload) throw new Error('a new file version did not re-read the document')
const afterReload = pageRegistration.component({
  ...props,
  useResource: () => ({ status: 'live', value: { absolutePath: '/ws/docs/demo.md', version: 'v2', bytes: 700 } }),
})
const reloadedClasses = new Set()
walk(afterReload, (node) => {
  if (typeof node.type === 'string' && typeof node.props.className === 'string') node.props.className.split(/\s+/).forEach((name) => reloadedClasses.add(name))
})
if (!reloadedClasses.has('mo-md')) throw new Error('the document disappeared after a version change')

// Closing a tab keeps its catalog row so the reader can come back to it.
openTabsSnapshot = [{ sessionId: 'sess-1', tabId: 'tab-1', kind: 'markdown-outline', contentId: ADDRESS }]
openTabsListeners.forEach((listener) => listener())
await new Promise((resolve) => setTimeout(resolve, 0))
const kept = pageRegistration.component(props)
const keptRows = collect(kept, (node) => typeof node.type === 'string' && node.props.className === 'mo-row mo-row-file')
if (keptRows.length !== 2) throw new Error(`closing a tab dropped its catalog row: ${keptRows.length} rows remain`)

// Setext headings, soft/hard breaks, and intraword underscores.
openTabsSnapshot = [
  ...openTabsSnapshot,
  { sessionId: 'sess-1', tabId: 'tab-3', kind: 'markdown-outline', contentId: 'dsh-resource://file/session/sess-1/docs/special.md' },
  { sessionId: 'sess-1', tabId: 'tab-4', kind: 'markdown-outline', contentId: 'dsh-resource://file/session/sess-1/docs/empty.md' },
]
openTabsListeners.forEach((listener) => listener())
await new Promise((resolve) => setTimeout(resolve, 0))

const specialAddress = 'dsh-resource://file/session/sess-1/docs/special.md'
const specialTab = { ...tab, id: 'tab-3', title: 'special.md', contentId: specialAddress,
  navigation: { address: specialAddress, params: undefined, revision: 0 } }
componentRegistration.component({
  ...props,
  useTabInfo: () => ({ sidebar: { expanded: true }, panel: { id: 'pane-1', isFloating: false }, tab: specialTab }),
})
const specialPanel = pageRegistration.component({
  ...props,
  useResource: () => ({ status: 'live', value: { absolutePath: '/ws/docs/special.md', version: 'v1' } }),
})
const specialHeadings = collect(specialPanel, (node) => typeof node.type === 'string' && /^h[1-6]$/.test(node.type))
if (specialHeadings.length !== 1 || specialHeadings[0].type !== 'h1') {
  throw new Error(`setext heading was not rendered as H1: ${JSON.stringify(specialHeadings.map((node) => node.type))}`)
}
const brs = collect(specialPanel, (node) => node.type === 'br')
if (brs.length !== 1) throw new Error(`expected exactly one hard break, found ${brs.length}`)
const emphasis = collect(specialPanel, (node) => node.type === 'em')
if (emphasis.length !== 0) throw new Error(`intraword underscore turned into emphasis: ${emphasis.length}`)
const specialChipRows = collect(pageRegistration.component(props), (node) => typeof node.type === 'string' && node.props.className === 'mo-row mo-row-file')
if (specialChipRows.length !== 4) throw new Error(`the catalog did not grow to four files: ${specialChipRows.length}`)

const emptyAddress = 'dsh-resource://file/session/sess-1/docs/empty.md'
const emptyTab = { ...tab, id: 'tab-4', title: 'empty.md', contentId: emptyAddress,
  navigation: { address: emptyAddress, params: undefined, revision: 0 } }
componentRegistration.component({
  ...props,
  useTabInfo: () => ({ sidebar: { expanded: true }, panel: { id: 'pane-1', isFloating: false }, tab: emptyTab }),
})
const emptyPanel = pageRegistration.component({
  ...props,
  useResource: () => ({ status: 'live', value: { absolutePath: '/ws/docs/empty.md', version: 'v1' } }),
})
const emptyTexts = []
walk(emptyPanel, (node) => {
  for (const child of node.children) if (typeof child === 'string') emptyTexts.push(child)
})
if (!emptyTexts.includes('state.empty')) throw new Error(`an empty file did not show the empty state: ${JSON.stringify(emptyTexts)}`)

// Disposal removes the catalog and the tab registrations.
disposeFns.forEach((dispose) => dispose())
console.log(JSON.stringify({
  ok: true,
  readCalls,
  panelClasses: [...classes].sort(),
  pageClasses: [...drawerClasses].sort(),
  headings: headingTexts,
}, null, 2))
