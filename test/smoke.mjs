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
  document: { baseURI: 'http://127.0.0.1:54514/', querySelector: () => null },
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
let viewRegistration
const viewActivations = []
const opened = []
let openTabsSnapshot = []
const openTabsListeners = []
const disposeFns = []
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
      const known = ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'conversation.view']
      if (!known.includes(name)) throw new Error(`unexpected slot ${name}`)
      callback()
    },
    register(options, component) {
      if (options.name === 'sidebar.right.pane.tab.title') titleRegistration = { options, component }
      else if (options.name === 'conversation.view') viewRegistration = { options, component }
      else componentRegistration = { options, component }
      return () => {}
    },
  },
  uiConversation: {
    binding(id) {
      return { activate(view) { viewActivations.push([id, view]) } }
    },
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
if (viewRegistration === undefined) throw new Error('session view was not registered')
if (tabDefinition.priority !== 'extension') throw new Error(`unexpected band ${tabDefinition.priority}`)
if (!tabDefinition.patterns.includes('*.md')) throw new Error('patterns do not claim *.md')
if (tabDefinition.canOpen('dsh-resource://file/session/sess-1/a/b.md') !== true) throw new Error('canOpen rejected a .md session address')
if (tabDefinition.canOpen('dsh-resource://file/session/sess-1/a/b.txt') !== false) throw new Error('canOpen accepted a non-markdown path')
if (tabDefinition.canOpen('dsh-resource://file/absolute/a/b.md') !== false) throw new Error('canOpen accepted an absolute address')
if (tabDefinition.canOpen('dsh-resource://plan/sess-1/call-9') !== true) throw new Error('canOpen rejected a plan address')
if (tabDefinition.title(ADDRESS) !== 'demo.md') throw new Error(`unexpected title ${tabDefinition.title(ADDRESS)}`)
if (viewRegistration.options.id !== 'dsh-markdown-outline') throw new Error(`unexpected view id ${viewRegistration.options.id}`)

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
  t: (key) => key,
}

function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') return
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return }
  if (typeof node !== 'object') return
  if (typeof node.type === 'function') {
    walk(node.type(node.props === undefined ? {} : node.props), visit)
    return
  }
  if (node.type === undefined || typeof node.type === 'symbol') {
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

const classSet = (root) => {
  const set = new Set()
  walk(root, (node) => {
    if (typeof node.type === 'string' && typeof node.props.className === 'string') {
      node.props.className.split(/\s+/).forEach((name) => set.add(name))
    }
  })
  return set
}
const textsOf = (root) => {
  const out = []
  walk(root, (node) => {
    for (const child of node.children) if (typeof child === 'string') out.push(child)
  })
  return out
}
const fileRowsOf = (root) => collect(root, (node) => typeof node.type === 'string' && node.props.className === 'mo-row mo-row-file')
const fileBodiesOf = (root) => fileRowsOf(root).flatMap((row) => collect(row, (node) => node.type === 'button' && node.props.className === 'mo-rowbody'))
const renderView = (override) => viewRegistration.component({ ...props, ...override, sessionId: 'sess-1' })
const redirect = (override) => componentRegistration.component({ ...props, ...override, sessionId: 'sess-1' })

// The tab body hands the document to the Session view, which becomes the reading surface.
const redirected = redirect({})
if (redirected !== null) throw new Error('the tab body should render nothing and redirect')
if (!viewActivations.some(([id, view]) => id === 'sess-1' && view === 'dsh-markdown-outline')) {
  throw new Error(`the tab body did not activate the session view: ${JSON.stringify(viewActivations)}`)
}

// The view shows the file the redirect selected, with its outline and document.
const view = renderView({})
const viewClasses = classSet(view)
for (const expected of ['mo-page', 'mo-tree', 'mo-page-doc', 'mo-head', 'mo-scroll', 'mo-md']) {
  if (!viewClasses.has(expected)) throw new Error(`the session view is missing .${expected}`)
}
for (const expected of ['demo.md', 'Overview', 'Details', 'Deep heading']) {
  if (!textsOf(view).join(' ').includes(expected)) throw new Error(`the session view is missing ${JSON.stringify(expected)}`)
}
const headingLines = collect(view, (node) => typeof node.type === 'string' && /^h[1-6]$/.test(node.type))
  .map((node) => node.props['data-md-line'])
if (headingLines.join(',') !== '6,10,17') throw new Error(`unexpected heading source lines: ${headingLines.join(',')}`)
if (!viewClasses.has('mo-md-code') && !viewClasses.has('mo-md-code-head')) throw new Error('code block was not rendered')
if (!viewClasses.has('mo-md-frontmatter')) throw new Error('frontmatter block was not rendered')
if (!viewClasses.has('mo-md-img')) throw new Error('image was not resolved')
if (!viewClasses.has('mo-md-link')) throw new Error('inline link was not rendered')
if (readCalls === 0) throw new Error('the catalog never read the file')

// Selecting a second opened file switches the document pane.
openTabsSnapshot = [
  { sessionId: 'sess-1', tabId: 'tab-1', kind: 'markdown-outline', contentId: ADDRESS },
  { sessionId: 'sess-1', tabId: 'tab-2', kind: 'markdown-outline', contentId: 'dsh-resource://file/session/sess-1/docs/second.md' },
]
openTabsListeners.forEach((listener) => listener())
await new Promise((resolve) => setTimeout(resolve, 0))
const twoFiles = renderView({})
if (fileRowsOf(twoFiles).length !== 2) throw new Error(`expected two file rows, found ${fileRowsOf(twoFiles).length}`)
const bodies = fileBodiesOf(twoFiles)
if (bodies.length !== 2) throw new Error(`expected two file open buttons, found ${bodies.length}`)
bodies[1].props.onClick()
const afterSelect = renderView({})
const afterSelectClasses = classSet(afterSelect)
if (!afterSelectClasses.has('mo-page-doc') || !afterSelectClasses.has('mo-md')) throw new Error('selecting a row did not show the document')
const docTitles = collect(afterSelect, (node) => typeof node.type === 'string' && node.props.className === 'mo-title')
  .map((node) => node.children.join(''))
if (!docTitles.some((title) => title.includes('second.md'))) throw new Error(`the document pane did not switch files: ${JSON.stringify(docTitles)}`)

// A newer version of the open file re-reads it (the live-refresh path).
const beforeReload = readCalls
const v2 = { useResource: () => ({ status: 'live', value: { absolutePath: '/ws/docs/second.md', version: 'v2', bytes: 700 } }) }
walk(renderView(v2), () => {})
await new Promise((resolve) => setTimeout(resolve, 0))
if (readCalls <= beforeReload) throw new Error('a new file version did not re-read the document')
if (!classSet(renderView(v2)).has('mo-md')) throw new Error('the document disappeared after a version change')

// Closing a tab keeps its catalog row so the reader can come back to it.
openTabsSnapshot = [{ sessionId: 'sess-1', tabId: 'tab-1', kind: 'markdown-outline', contentId: ADDRESS }]
openTabsListeners.forEach((listener) => listener())
await new Promise((resolve) => setTimeout(resolve, 0))
if (fileRowsOf(renderView({})).length !== 2) throw new Error('closing a tab dropped its catalog row')

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
redirect({ useTabInfo: () => ({ sidebar: { expanded: true }, panel: { id: 'pane-1', isFloating: false }, tab: specialTab }) })
const specialView = renderView({ useResource: () => ({ status: 'live', value: { absolutePath: '/ws/docs/special.md', version: 'v1' } }) })
const specialHeadings = collect(specialView, (node) => typeof node.type === 'string' && /^h[1-6]$/.test(node.type))
if (specialHeadings.length !== 1 || specialHeadings[0].type !== 'h1') {
  throw new Error(`setext heading was not rendered as H1: ${JSON.stringify(specialHeadings.map((node) => node.type))}`)
}
if (collect(specialView, (node) => node.type === 'br').length !== 1) throw new Error('expected exactly one hard break')
if (collect(specialView, (node) => node.type === 'em').length !== 0) throw new Error('intraword underscore turned into emphasis')
if (fileRowsOf(specialView).length !== 4) throw new Error(`the catalog did not grow to four files: ${fileRowsOf(specialView).length}`)

// An empty file shows the empty state.
const emptyAddress = 'dsh-resource://file/session/sess-1/docs/empty.md'
const emptyTab = { ...tab, id: 'tab-4', title: 'empty.md', contentId: emptyAddress,
  navigation: { address: emptyAddress, params: undefined, revision: 0 } }
redirect({ useTabInfo: () => ({ sidebar: { expanded: true }, panel: { id: 'pane-1', isFloating: false }, tab: emptyTab }) })
const emptyView = renderView({ useResource: () => ({ status: 'live', value: { absolutePath: '/ws/docs/empty.md', version: 'v1' } }) })
if (!textsOf(emptyView).includes('state.empty')) throw new Error(`an empty file did not show the empty state: ${JSON.stringify(textsOf(emptyView))}`)

// A plan opens the view and renders its Markdown through the plan resource.
const planAddress = 'dsh-resource://plan/sess-1/call-9'
const planTab = { ...tab, id: 'tab-plan', title: 'Plan', contentId: planAddress,
  navigation: { address: planAddress, params: undefined, revision: 0 } }
redirect({ useTabInfo: () => ({ sidebar: { expanded: true }, panel: { id: 'pane-1', isFloating: false }, tab: planTab }) })
const planProps = {
  useResource: (address) => address.startsWith('dsh-resource://plan/')
    ? { status: 'live', value: { callId: 'call-9', title: 'Plan title', markdown: '# Plan title\n\n## Step\n' }, version: 'v1' }
    : { status: 'live', value: { absolutePath: '/ws/docs/demo.md', version: 'v1' } },
}
const planView = renderView(planProps)
walk(planView, () => {})
if (!classSet(planView).has('mo-md')) throw new Error('the plan Markdown did not render in the session view')
const planTitles = collect(planView, (node) => typeof node.type === 'string' && node.props.className === 'mo-title')
  .map((node) => node.children.join(''))
if (!planTitles.some((title) => title.includes('Plan title'))) throw new Error(`the plan title did not reach the document pane: ${JSON.stringify(planTitles)}`)
const planRows = fileRowsOf(renderView(planProps))
if (planRows.length !== 5) throw new Error(`the plan row did not join the document list: ${planRows.length}`)
if (!collect(renderView(planProps), (node) => typeof node.type === 'string' && node.props.className === 'mo-row-label')
  .some((node) => node.children.join('').includes('Plan title'))) {
  throw new Error('the plan title did not reach the tree')
}

// The tab chip renders the markdown glyph before the captured title.
const chip = titleRegistration.component({ useTabInfo: props.useTabInfo })
const chipText = (chip.children || []).filter((child) => typeof child === 'string')
if (!chipText.join('').includes('demo.md')) throw new Error(`title component did not include the tab title: ${JSON.stringify(chipText)}`)

// Disposal removes the catalog and the tab registrations.
disposeFns.forEach((dispose) => dispose())
console.log(JSON.stringify({
  ok: true,
  readCalls,
  viewClasses: [...viewClasses].sort(),
  headingLines,
  planRows: planRows.length,
}, null, 2))
