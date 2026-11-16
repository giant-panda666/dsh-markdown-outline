/**
 * Markdown outline preview — the browser half of `dsh-markdown-outline`.
 *
 * It contributes one right-Sidebar tab type at the `extension` band for `.md`
 * addresses, so a Markdown file opened from a session (chat link, tool row,
 * file tree) renders here instead of in the plain document preview. The tab
 * draws two columns: an outline tree (workspace / session / file / headings)
 * collected from every open tab of this type, and the rendered document. The
 * file's `file` resource metadata is observed through the standard hook, so a
 * version change on disk re-reads the document while it is open, and switching
 * back to a tab reads the latest version again.
 *
 * Only React from the platform module table is imported: no Harness Client
 * package is loaded as a module, and every visual token is a `--dsw-*` theme
 * token.
 */
window.__ModuleLoader__.load({
  id: 'dsh-markdown-outline',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const {
      useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
    } = React

    /** This implementation's identity in the tab system, and its slot key. */
    const ID = 'dsh-markdown-outline'
    /**
     * The tab kind this type owns. It stays `markdown-outline` across the
     * package rename: the kind is persisted in Sidebar layouts, so keeping it
     * keeps already-open Markdown tabs working.
     */
    const KIND = 'markdown-outline'
    /** Client locale namespace and the package's display namespace. */
    const NS = 'markdownOutline'
    /** Address prefix for file resources. */
    const FILE_PREFIX = 'dsh-resource://file/'
    /** Keep catalog reads and rendered text bounded. */
    const MAX_DOC_CHARS = 4 * 1024 * 1024
    const MAX_PAGES = 40
    const MAX_HEADINGS = 400
    /** Per-Sidebar-Session catalog cap; the oldest entries leave first. */
    const MAX_CATALOG_ENTRIES = 60
    /** Persisted panel preferences (tree visibility and collapsed nodes). */
    const UI_KEY = 'dsh.markdown-outline.ui.v1'

    // ---------------------------------------------------------------- locale

    const zh = {
      'tree.title': '大纲',
      'tree.count': '{count} 个文件',
      'tree.empty': '点击会话中的 Markdown 文件后，这里会按“工作区 / 会话 / 文件 / 标题”列出目录。',
      'tree.loading': '读取中…',
      'tree.expand': '展开',
      'tree.collapse': '收起',
      'action.refresh': '重新读取文件',
      'outline.title': 'Markdown 预览',
      'outline.planName': '计划',
      'action.builtin': '用内置预览打开',
      'state.loading': '正在读取文件…',
      'state.empty': '这个 Markdown 文件没有内容。',
      'state.truncated': '文件较大，只显示了前面一部分。',
      'state.updated': '文件已更新',
      'error.notFound': '文件不存在，可能已被移动或删除。',
      'error.tooLarge': '文件超过读取上限，无法完整显示。',
      'error.notText': '该文件不是可显示的文本文件。',
      'error.notRegularFile': '该路径不是普通文件，没有可显示的内容。',
      'error.resource': '文件资源服务不可用。',
      'error.unavailable': '读取失败：{message}',
      'error.retry': '重试',
      'md.copy': '复制',
      'md.copied': '已复制',
      'md.language': '代码',
      'md.frontmatter': '文档信息',
    }

    const en = {
      'tree.title': 'Outline',
      'tree.count': '{count} files',
      'tree.empty': 'Open a Markdown file from a session and this tree lists it by workspace, session, file, and heading.',
      'tree.loading': 'Reading…',
      'tree.expand': 'Expand',
      'tree.collapse': 'Collapse',
      'action.refresh': 'Read the file again',
      'outline.title': 'Markdown preview',
      'outline.planName': 'Plan',
      'action.builtin': 'Open in the built-in preview',
      'state.loading': 'Reading document…',
      'state.empty': 'This Markdown file has no content.',
      'state.truncated': 'The file is large; only the beginning is shown.',
      'state.updated': 'File updated',
      'error.notFound': 'File not found. It may have been moved or deleted.',
      'error.tooLarge': 'The file exceeds the read limit and cannot be shown completely.',
      'error.notText': 'This file is not displayable text.',
      'error.notRegularFile': 'Not a regular file, nothing to display.',
      'error.resource': 'The file resource service is unavailable.',
      'error.unavailable': 'Read failed: {message}',
      'error.retry': 'Retry',
      'md.copy': 'Copy',
      'md.copied': 'Copied',
      'md.language': 'Code',
      'md.frontmatter': 'Document metadata',
    }

    // ------------------------------------------------------------- addresses

    /**
     * Read a `dsh-resource://file/…` address into its session and path.
     * Mirrors the workspace-path grammar: every id and path segment is
     * component-encoded, and query or fragment suffixes are ignored.
     * @param address - candidate resource address.
     * @returns `{ sessionId, path }` for a session-scoped file address, else undefined.
     */
    function parseSessionAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(FILE_PREFIX)) return undefined
      const end = address.search(/[?#]/)
      const rest = address.slice(FILE_PREFIX.length, end === -1 ? undefined : end)
      const parts = rest.split('/')
      if (parts[0] !== 'session') return undefined
      const id = parts[1]
      const segments = parts.slice(2)
      if (!id || segments.length === 0) return undefined
      try {
        return { sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') }
      } catch (_malformed) {
        return undefined
      }
    }

    const PLAN_PREFIX = 'dsh-resource://plan/'

    /**
     * Parse a plan resource address: `dsh-resource://plan/<sessionId>/<callId>`,
     * or the subagent form whose parent Session is what a reader groups by.
     * @param address - a candidate address.
     * @returns the owning Session and call id, or undefined for another scheme.
     */
    function parsePlanAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(PLAN_PREFIX)) return undefined
      const end = address.search(/[?#]/)
      const parts = address.slice(PLAN_PREFIX.length, end === -1 ? undefined : end).split('/')
      try {
        if (parts.length === 2 && parts[0] !== '' && parts[1] !== '') {
          return { sessionId: decodeURIComponent(parts[0]), callId: decodeURIComponent(parts[1]) }
        }
        if (parts.length === 5 && parts[0] === 'subagent' && parts[1] !== '' && parts[4] !== '') {
          return { sessionId: decodeURIComponent(parts[1]), callId: decodeURIComponent(parts[4]) }
        }
      } catch (_malformed) { /* A malformed escape names no plan. */ }
      return undefined
    }

    /**
     * Build a session file address, matching how the Sidebar encodes one.
     * @param sessionId - authorizing session.
     * @param path - workspace-relative or absolute `/`-separated path.
     * @returns the resource address.
     */
    function sessionFileAddress(sessionId, path) {
      const encoded = path.replace(/\\/g, '/').split('/').map(segment =>
        encodeURIComponent(segment).replace(/%3A/gi, ':')).join('/')
      return `${FILE_PREFIX}session/${encodeURIComponent(sessionId)}/${encoded}`
    }

    /** @param path - file path. @returns whether the path names a Markdown document. */
    function isMarkdownPath(path) {
      return /\.(?:md|markdown|mdown|mdx)$/i.test(path)
    }

    /** @param path - `/`-separated path. @returns its last segment. */
    function basenameOf(path) {
      const trimmed = path.replace(/\/+$/, '')
      return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
    }

    /** @param path - `/`-separated file path. @returns its directory, with a trailing slash. */
    function dirnameOf(path) {
      const index = path.lastIndexOf('/')
      return index < 0 ? '' : path.slice(0, index + 1)
    }

    /**
     * Resolve a relative link against the document's directory.
     * @param base - directory path with a trailing slash (absolute or workspace-relative).
     * @param href - authored target.
     * @returns the resolved path, or undefined when the target escapes the path grammar.
     */
    function resolveRelativePath(base, href) {
      // A query or fragment is not part of the target path; the fragment of a
      // same-document link is handled before this resolver runs.
      const cut = href.search(/[?#]/)
      let decoded = cut === -1 ? href : href.slice(0, cut)
      try {
        decoded = decodeURIComponent(decoded)
      } catch (_malformed) {
        return undefined
      }
      if (decoded.length === 0) return undefined
      const absolute = decoded.startsWith('/')
      const segments = (absolute ? decoded : base + decoded).split('/')
      const out = []
      for (const segment of segments) {
        if (segment === '' && out.length === 0) {
          out.push('')
          continue
        }
        if (segment === '' || segment === '.') continue
        if (segment === '..') {
          if (out.length <= 1) return undefined
          out.pop()
          continue
        }
        out.push(segment)
      }
      return out.join('/')
    }

    /** @param template - copy with `{name}` placeholders. @param values - replacements. @returns the formatted string. */
    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (
        values !== undefined && values[key] !== undefined ? String(values[key]) : match))
    }

    // ------------------------------------------------------------- markdown

    /** @param text - inline Markdown. @returns the text without inline markers, for outline rows. */
    function plainInline(text) {
      return String(text)
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/_([^_]+)_/g, '$1')
        .replace(/~~([^~]+)~~/g, '$1')
        .replace(/<[^>]+>/g, '')
        .trim()
    }

    /**
     * Split a leading YAML frontmatter block from the document body.
     * @param text - complete document source.
     * @returns the frontmatter source and body, or undefined when there is no block.
     */
    function splitFrontmatter(text) {
      if (!text.startsWith('---')) return undefined
      const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text)
      if (match === null) return undefined
      return { source: match[1], body: text.slice(match[0].length) }
    }

    /**
     * Collect ATX headings with their source lines, skipping fenced code and a
     * leading frontmatter block.
     * @param text - document source.
     * @returns ordered outline entries `{ level, text, line }`.
     */
    function parseHeadings(text) {
      const split = splitFrontmatter(text)
      const source = split === undefined ? text : split.body
      const offset = split === undefined ? 0 : text.slice(0, text.length - split.body.length).split('\n').length - 1
      const lines = source.split('\n')
      const headings = []
      let fence = null
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line)
        if (fenceMatch !== null) {
          if (fence === null) fence = fenceMatch[1][0]
          else if (fence === fenceMatch[1][0]) fence = null
          continue
        }
        if (fence !== null) continue
        const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
        if (heading === null) continue
        const label = plainInline(heading[2])
        if (label.length === 0) continue
        headings.push({ level: heading[1].length, text: label, line: offset + index + 1 })
        if (headings.length >= MAX_HEADINGS) break
      }
      return headings
    }

    /** @param text - heading text. @returns a GitHub-compatible anchor slug. */
    function slugify(text) {
      return plainInline(text).toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-')
    }

    /** @param line - source line. @param lines - block context. @param index - line index. @returns whether the line opens a block. */
    function startsBlock(line, lines, index) {
      if (/^ {0,3}(#{1,6})\s+/.test(line)) return true
      if (/^ {0,3}(`{3,}|~{3,})/.test(line)) return true
      if (/^ {0,3}>/.test(line)) return true
      if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) return true
      if (/^ *([-*+]|\d{1,9}[.)])\s+/.test(line)) return true
      if (line.includes('|') && index + 1 < lines.length
        && /^ {0,3}\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[index + 1])) return true
      return false
    }

    /**
     * Split one table row into cells, honoring escaped pipes.
     * @param row - table row source.
     * @returns trimmed cell sources.
     */
    function splitTableRow(row) {
      let text = row.trim()
      if (text.startsWith('|')) text = text.slice(1)
      if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)
      const cells = []
      let current = ''
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index]
        if (char === '\\' && text[index + 1] === '|') {
          current += '|'
          index += 1
          continue
        }
        if (char === '|') {
          cells.push(current.trim())
          current = ''
          continue
        }
        current += char
      }
      cells.push(current.trim())
      return cells
    }

    /**
     * Parse a Markdown document into renderable blocks.
     * @param lines - source lines.
     * @param startLine - 1-based source line of `lines[0]`.
     * @returns block list.
     */
    function parseBlocks(lines, startLine) {
      const blocks = []
      let index = 0
      while (index < lines.length) {
        const line = lines[index]
        const lineNo = startLine + index
        if (/^\s*$/.test(line)) {
          index += 1
          continue
        }
        const fenceMatch = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line)
        if (fenceMatch !== null) {
          const marker = fenceMatch[1][0]
          const size = fenceMatch[1].length
          const info = fenceMatch[2].trim()
          const body = []
          index += 1
          const close = new RegExp(`^ {0,3}${marker === '`' ? '`' : '~'}{${size},}\\s*$`)
          while (index < lines.length) {
            if (close.test(lines[index])) {
              index += 1
              break
            }
            body.push(lines[index])
            index += 1
          }
          blocks.push({ type: 'code', lang: info.split(/\s+/)[0] || '', text: body.join('\n'), line: lineNo })
          continue
        }
        const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
        if (heading !== null) {
          blocks.push({ type: 'heading', level: heading[1].length, text: heading[2], line: lineNo })
          index += 1
          continue
        }
        if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
          blocks.push({ type: 'hr', line: lineNo })
          index += 1
          continue
        }
        if (line.includes('|') && index + 1 < lines.length
          && /^ {0,3}\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[index + 1])) {
          const header = splitTableRow(line)
          const align = splitTableRow(lines[index + 1]).map((cell) => {
            const left = cell.startsWith(':')
            const right = cell.endsWith(':')
            if (left && right) return 'center'
            if (right) return 'right'
            if (left) return 'left'
            return undefined
          })
          index += 2
          const rows = []
          while (index < lines.length && /\S/.test(lines[index]) && lines[index].includes('|')) {
            rows.push(splitTableRow(lines[index]))
            index += 1
          }
          blocks.push({ type: 'table', header, align, rows, line: lineNo })
          continue
        }
        if (/^ {0,3}>/.test(line)) {
          const inner = []
          while (index < lines.length && /^ {0,3}>/.test(lines[index])) {
            inner.push(lines[index].replace(/^ {0,3}> ?/, ''))
            index += 1
          }
          blocks.push({ type: 'quote', blocks: parseBlocks(inner, lineNo), line: lineNo })
          continue
        }
        if (/^ *([-*+]|\d{1,9}[.)])\s+/.test(line)) {
          const parsed = parseList(lines, index, startLine)
          blocks.push(parsed.block)
          index = parsed.next
          continue
        }
        if (!/^ {4}/.test(line) && index + 1 < lines.length) {
          const setext = /^ {0,3}(=+|-{2,})\s*$/.exec(lines[index + 1])
          if (setext !== null) {
            blocks.push({ type: 'heading', level: setext[1][0] === '=' ? 1 : 2, text: line.trim(), line: lineNo })
            index += 2
            continue
          }
        }
        if (/^ {4}\S/.test(line)) {
          const body = []
          while (index < lines.length && (/^ {4}/.test(lines[index]) || /^\s*$/.test(lines[index]))) {
            body.push(lines[index].replace(/^ {4}/, ''))
            index += 1
          }
          while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
          blocks.push({ type: 'code', lang: '', text: body.join('\n'), line: lineNo })
          continue
        }
        const paragraph = [line]
        index += 1
        while (index < lines.length && /\S/.test(lines[index]) && !startsBlock(lines[index], lines, index)) {
          paragraph.push(lines[index])
          index += 1
        }
        blocks.push({ type: 'paragraph', text: paragraph.join('\n'), line: lineNo })
      }
      return blocks
    }

    /**
     * Parse one list starting at `start`, including nested content.
     * @param lines - source lines.
     * @param start - index of the first item line.
     * @param startLine - 1-based source line of `lines[0]`.
     * @returns the list block and the next line index.
     */
    function parseList(lines, start, startLine) {
      const first = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[start])
      const indent = first[1].length
      const ordered = /^\d/.test(first[2])
      const items = []
      let index = start
      while (index < lines.length) {
        const itemMatch = /^( *)([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/.exec(lines[index])
        if (itemMatch === null || itemMatch[1].length !== indent || /^\d/.test(itemMatch[2]) !== ordered) break
        const contentIndent = indent + itemMatch[2].length + 1
        const itemLines = [itemMatch[3] === undefined ? '' : itemMatch[3]]
        const itemLine = startLine + index
        index += 1
        while (index < lines.length) {
          const current = lines[index]
          if (/^\s*$/.test(current)) {
            const next = lines[index + 1]
            const nextItem = next === undefined ? null : /^( *)([-*+]|\d{1,9}[.)])\s+/.exec(next)
            if (nextItem !== null && nextItem[1].length === indent) {
              index += 1
              break
            }
            if (next === undefined || !/^\s{2,}\S/.test(next)) {
              index += 1
              break
            }
            itemLines.push('')
            index += 1
            continue
          }
          const currentIndent = /^( *)/.exec(current)[1].length
          const sibling = /^( *)([-*+]|\d{1,9}[.)])\s+/.exec(current)
          if (sibling !== null && sibling[1].length === indent) break
          if (currentIndent <= indent && sibling === null) break
          itemLines.push(current.slice(Math.min(currentIndent, contentIndent)))
          index += 1
        }
        let task = null
        const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(itemLines[0])
        if (taskMatch !== null) {
          task = taskMatch[1].toLowerCase() === 'x'
          itemLines[0] = taskMatch[2]
        }
        items.push({ task, blocks: parseBlocks(itemLines, itemLine) })
      }
      const startNumber = ordered ? Number.parseInt(first[2], 10) : 1
      return { block: { type: 'list', ordered, start: startNumber, items, line: startLine + start }, next: index }
    }

    /**
     * Build the React nodes for one paragraph or item of inline Markdown.
     * @param text - inline source.
     * @param context - outline/document context: `{ openLink, openImage, inline }`.
     * @param keyBase - React key prefix.
     * @returns inline nodes.
     */
    function renderInline(text, context, keyBase) {
      const nodes = []
      let buffer = ''
      let index = 0
      let key = 0
      const push = (node) => {
        if (buffer.length > 0) {
          nodes.push(buffer)
          buffer = ''
        }
        nodes.push(node)
      }
      const nextKey = () => `${keyBase}-${(key += 1)}`
      while (index < text.length) {
        const char = text[index]
        if (char === '\\' && index + 1 < text.length && /[\\`*_{}[\]()#+\-.!>~|]/.test(text[index + 1])) {
          buffer += text[index + 1]
          index += 2
          continue
        }
        if (char === '`') {
          let ticks = 1
          while (text[index + ticks] === '`') ticks += 1
          const marker = '`'.repeat(ticks)
          const close = text.indexOf(marker, index + ticks)
          if (close !== -1) {
            push(h('code', { key: nextKey() }, text.slice(index + ticks, close)))
            index = close + ticks
            continue
          }
        }
        if (char === '!' && text[index + 1] === '[') {
          const match = /^!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/.exec(text.slice(index))
          if (match !== null) {
            const resolved = context.resolveImage(match[2])
            push(resolved === undefined
              ? h('span', { key: nextKey(), className: 'mo-md-alt' }, match[1] || 'image')
              : h('img', { key: nextKey(), className: 'mo-md-img', src: resolved, alt: match[1] || '' }))
            index += match[0].length
            continue
          }
        }
        if (char === '[') {
          const match = /^\[((?:[^\[\]]|\[[^\]]*\])*)\]\(\s*([^\s)]*)(?:\s+["'][^"']*["'])?\s*\)/.exec(text.slice(index))
          if (match !== null) {
            const label = renderInline(match[1], context, nextKey())
            push(h('a', {
              key: nextKey(),
              href: match[2],
              className: 'mo-md-link',
              title: match[2],
              onClick: (event) => {
                event.preventDefault()
                context.openLink(match[2], event)
              },
            }, ...label))
            index += match[0].length
            continue
          }
        }
        if (char === '<') {
          const match = /^<((?:https?|mailto):[^>\s]+)>/.exec(text.slice(index))
          if (match !== null) {
            push(h('a', {
              key: nextKey(),
              href: match[1],
              className: 'mo-md-link',
              title: match[1],
              onClick: (event) => {
                event.preventDefault()
                context.openLink(match[1], event)
              },
            }, match[1]))
            index += match[0].length
            continue
          }
        }
        if (char === '*' || char === '_' || char === '~') {
          // `snake_case_name` is an identifier, not emphasis.
          if (char === '_' && index > 0 && /\w/.test(text[index - 1])) {
            buffer += char
            index += 1
            continue
          }
          if (char !== '~' && text.startsWith(char + char + char, index)) {
            const triple = char + char + char
            const close = text.indexOf(triple, index + 3)
            if (close !== -1) {
              push(h('strong', { key: nextKey() },
                h('em', { key: nextKey() }, ...renderInline(text.slice(index + 3, close), context, nextKey()))))
              index = close + 3
              continue
            }
          }
          const pair = char === '~' ? '~~' : char + char
          const strong = char !== '~' && text.startsWith(pair, index)
          const marker = strong || char === '~' ? pair : char
          const close = text.indexOf(marker, index + marker.length)
          if (close !== -1 && close > index + marker.length) {
            const inner = text.slice(index + marker.length, close)
            const children = renderInline(inner, context, nextKey())
            if (char === '~') push(h('del', { key: nextKey() }, ...children))
            else if (strong) push(h('strong', { key: nextKey() }, ...children))
            else push(h('em', { key: nextKey() }, ...children))
            index = close + marker.length
            continue
          }
        }
        if (/\s/.test(char)) {
          let run = 1
          while (index + run < text.length && /[ \t]/.test(text[index + run])) run += 1
          buffer += text.slice(index, index + run)
          index += run
          continue
        }
        buffer += char
        index += 1
      }
      if (buffer.length > 0) nodes.push(buffer)
      return nodes
    }

    /**
     * Render paragraph text, preserving authored line breaks.
     * @param text - paragraph source.
     * @param context - render context.
     * @param keyBase - key prefix.
     * @returns nodes with `<br>` for newlines.
     */
    function renderParagraph(text, context, keyBase) {
      const lines = text.split('\n')
      const nodes = []
      lines.forEach((raw, index) => {
        // CommonMark soft break: two trailing spaces or a trailing backslash is
        // a hard break, every other source newline reads as a space.
        const hard = / {2,}$/.test(raw) || /\\$/.test(raw)
        const line = raw.replace(/ {2,}$/, '').replace(/\\$/, '')
        for (const node of renderInline(line, context, `${keyBase}-${index}`)) nodes.push(node)
        if (index < lines.length - 1) nodes.push(hard ? h('br', { key: `${keyBase}-br-${index}` }) : ' ')
      })
      return nodes
    }

    /** One fenced or indented code block with a copy control. */
    function CodeBlock(props) {
      const { lang, text, labels } = props
      const [copied, setCopied] = useState(false)
      const timer = useRef(null)
      useEffect(() => () => {
        if (timer.current !== null) clearTimeout(timer.current)
      }, [])
      const copy = () => {
        const write = navigator.clipboard !== undefined && navigator.clipboard.writeText !== undefined
          ? navigator.clipboard.writeText(text)
          : Promise.reject(new Error('clipboard unavailable'))
        write.then(() => {
          setCopied(true)
          if (timer.current !== null) clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1400)
        }, () => {})
      }
      return h('div', { className: 'mo-md-code' },
        h('div', { className: 'mo-md-code-head' },
          h('span', { className: 'mo-md-code-lang' }, lang.length > 0 ? lang : labels.language),
          h('button', {
            type: 'button',
            className: 'mo-md-copy',
            onClick: copy,
            title: labels.copy,
          }, copied ? labels.copied : labels.copy)),
        h('pre', null, h('code', null, text)))
    }

    /**
     * Render one parsed block list.
     * @param blocks - block list.
     * @param context - render context.
     * @param keyBase - key prefix.
     * @returns React nodes.
     */
    function renderBlocks(blocks, context, keyBase) {
      const nodes = []
      blocks.forEach((block, index) => {
        const key = `${keyBase}-b${index}`
        if (block.type === 'heading') {
          nodes.push(h(`h${block.level}`, {
            key,
            className: 'mo-md-heading',
            'data-md-line': String(block.line),
            'data-md-outline': 'true',
            'data-md-level': String(block.level),
          }, ...renderInline(block.text, context, key)))
          return
        }
        if (block.type === 'paragraph') {
          nodes.push(h('p', { key, 'data-md-line': String(block.line) },
            ...renderParagraph(block.text, context, key)))
          return
        }
        if (block.type === 'code') {
          nodes.push(h(CodeBlock, { key, lang: block.lang, text: block.text, labels: context.labels }))
          return
        }
        if (block.type === 'hr') {
          nodes.push(h('hr', { key, 'data-md-line': String(block.line) }))
          return
        }
        if (block.type === 'quote') {
          nodes.push(h('blockquote', { key, 'data-md-line': String(block.line) },
            ...renderBlocks(block.blocks, context, key)))
          return
        }
        if (block.type === 'list') {
          const tag = block.ordered ? 'ol' : 'ul'
          const items = block.items.map((item, itemIndex) => {
            const itemKey = `${key}-i${itemIndex}`
            const children = []
            if (item.task !== null) {
              children.push(h('input', {
                key: `${itemKey}-task`,
                type: 'checkbox',
                readOnly: true,
                checked: item.task,
                tabIndex: -1,
              }))
            }
            const rendered = renderBlocks(item.blocks, context, itemKey)
            if (rendered.length === 1 && item.blocks.length === 1 && item.blocks[0].type === 'paragraph') {
              children.push(h('span', { key: `${itemKey}-text` }, ...renderParagraph(item.blocks[0].text, context, itemKey)))
            } else {
              children.push(...rendered)
            }
            return h('li', { key: itemKey, className: item.task !== null ? 'mo-md-task' : undefined }, ...children)
          })
          nodes.push(h(tag, {
            key,
            'data-md-line': String(block.line),
            start: block.ordered && block.start !== 1 ? block.start : undefined,
          }, ...items))
          return
        }
        if (block.type === 'table') {
          nodes.push(h('div', { key, className: 'mo-md-tablewrap' },
            h('table', null,
              h('thead', null, h('tr', null, ...block.header.map((cell, cellIndex) => h('th', {
                key: `th-${cellIndex}`,
                style: block.align[cellIndex] === undefined ? undefined : { textAlign: block.align[cellIndex] },
              }, ...renderInline(cell, context, `${key}-th${cellIndex}`))))),
              h('tbody', null, ...block.rows.map((row, rowIndex) => h('tr', { key: `tr-${rowIndex}` },
                ...row.map((cell, cellIndex) => h('td', {
                  key: `td-${rowIndex}-${cellIndex}`,
                  style: block.align[cellIndex] === undefined ? undefined : { textAlign: block.align[cellIndex] },
                }, ...renderInline(cell, context, `${key}-td${rowIndex}-${cellIndex}`)))))))))
          return
        }
      })
      return nodes
    }

    /**
     * Render the leading frontmatter block as a compact key/value list.
     * @param source - YAML between the delimiters.
     * @param label - localized heading for the block.
     * @returns the metadata box.
     */
    function renderFrontmatter(source, label) {
      const rows = []
      const lines = source.split('\n')
      let rest = false
      for (const line of lines) {
        const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
        if (match === null) {
          if (/^\s+\S/.test(line) && rows.length > 0) {
            rows[rows.length - 1].value += ` ${line.trim()}`
            continue
          }
          rest = true
          break
        }
        rows.push({ key: match[1], value: match[2].replace(/^["']|["']$/g, '') })
      }
      if (rest || rows.length === 0) {
        return h('div', { className: 'mo-md-frontmatter' },
          h('div', { className: 'mo-md-fm-title' }, label),
          h('pre', { className: 'mo-md-fm-source' }, source))
      }
      return h('div', { className: 'mo-md-frontmatter' },
        h('div', { className: 'mo-md-fm-title' }, label),
        ...rows.map((row, index) => h('div', { key: `fm-${index}`, className: 'mo-md-fm-row' },
          h('span', { className: 'mo-md-fm-key' }, row.key),
          h('span', { className: 'mo-md-fm-value' }, row.value))))
    }

    /**
     * Render one complete Markdown document.
     * @param props - `{ text, resolveImage, openLink, labels, frontmatterLabel }`.
     * @returns the document body.
     */
    function MarkdownDocument(props) {
      const { text, resolveImage, openLink, labels, frontmatterLabel } = props
      const split = useMemo(() => splitFrontmatter(text), [text])
      // Rendered blocks carry source lines of the whole document, so heading
      // anchors and outline rows agree even with a frontmatter block above.
      const blocks = useMemo(() => {
        const body = split === undefined ? text : split.body
        const prefixLines = split === undefined ? 0 : text.slice(0, text.length - split.body.length).split('\n').length - 1
        return parseBlocks(body.split('\n'), prefixLines + 1)
      }, [text, split])
      const context = { resolveImage, openLink, labels }
      return h('div', { className: 'mo-md' },
        split === undefined ? null : renderFrontmatter(split.source, frontmatterLabel),
        ...renderBlocks(blocks, context, 'doc'))
    }

    // -------------------------------------------------------------- catalog

    /**
     * Build the shared catalog for one plugin lifetime.
     *
     * The outline is a per-Sidebar-Session catalog of the Markdown files this
     * type has opened, not only of tabs still open: closing a tab keeps its
     * entry so the reader can come back to it, and opening it again focuses or
     * creates a tab. Documents are cached by address and shared by every
     * session's outline; the panel reads the catalog through
     * `useSyncExternalStore` and asks for a document on mount or when the
     * observed file version changes.
     * @param ctx - client plugin context.
     * @returns catalog face used by the panel.
     */
    function createCatalog(ctx) {
      /** @type {Map<string, Map<string, { address: string, sessionId: string, path: string, name: string, order: number }>>} */
      const sessions = new Map()
      /** @type {Map<string, { status: string, text?: string, version?: string, absolutePath?: string, error?: unknown, truncated?: boolean, changedAt?: number }>} */
      const documents = new Map()
      /** @type {Map<string, { version?: string, headings: Array<{ level: number, text: string, line: number }> }>} */
      const outlines = new Map()
      /** @type {Map<string, { status: string, value?: { version?: string, absolutePath?: string }, failure?: unknown }>} */
      const observed = new Map()
      /** @type {Map<string, AbortController>} */
      const active = new Map()
      const listeners = new Set()
      let order = 0
      let sequence = 0
      let snapshot = { revision: 0 }
      let disposed = false

      const publish = () => {
        if (disposed) return
        sequence += 1
        snapshot = { revision: sequence }
        for (const listener of [...listeners]) listener()
      }

      /** @param address - resource address. @returns whether any Session's catalog still lists it. */
      const referenced = (address) => {
        for (const map of sessions.values()) {
          if (map.has(address)) return true
        }
        return false
      }

      /** @param address - resource address no catalog lists; drop its cache and read. */
      const forget = (address) => {
        if (referenced(address)) return
        documents.delete(address)
        outlines.delete(address)
        observed.delete(address)
        const controller = active.get(address)
        if (controller !== undefined) {
          controller.abort()
          active.delete(address)
        }
      }

      /** Keep each Session's catalog bounded, dropping its oldest entries. */
      const prune = () => {
        for (const map of sessions.values()) {
          if (map.size <= MAX_CATALOG_ENTRIES) continue
          const oldest = [...map.values()].sort((left, right) => left.order - right.order)
          for (const entry of oldest.slice(0, map.size - MAX_CATALOG_ENTRIES)) {
            map.delete(entry.address)
            forget(entry.address)
          }
        }
      }

      /**
       * Read one file completely through the paged text endpoint. Pages of two
       * versions never merge: a page whose version differs from the first one
       * ends the read as `mixed`, and the caller reads again.
       * @param sessionId - authorizing session.
       * @param path - path handed to the Host.
       * @param signal - cancellation for a superseded read.
       * @returns the text, its version, a truncation mark, and any failure.
       */
      const readDocument = async (sessionId, path, signal) => {
        const parts = []
        let offset = 1
        let version
        let absolutePath
        let size = 0
        let pages = 0
        let eof = false
        let failure
        let mixed = false
        while (!eof && pages < MAX_PAGES) {
          const result = await ctx.remote.workspaceFiles.read(sessionId, path, { offset }, signal)
          if (signal.aborted) return { aborted: true }
          if (!result.ok) {
            failure = result.error
            break
          }
          const page = result.value
          pages += 1
          if (version === undefined) {
            version = page.version
          } else if (page.version !== version) {
            mixed = true
            break
          }
          absolutePath = page.absolutePath
          if (page.text.length > 0) parts.push(page.text)
          size += page.text.length
          eof = page.eof === true || page.lines === 0
          offset += page.lines
          if (size >= MAX_DOC_CHARS) break
        }
        return {
          text: parts.length === 0 && failure !== undefined ? undefined : parts.join('\n'),
          version,
          absolutePath,
          truncated: !eof && failure === undefined && !mixed,
          mixed,
          failure,
        }
      }

      /**
       * Load (or reload) one address into the shared cache.
       * @param address - resource address.
       * @param file - parsed session file, when the caller already has it.
       * @param options - `force` discards a cached document of the same version; `attempt` bounds version races.
       */
      const load = (address, file, options) => {
        const force = options !== undefined && options.force === true
        const attempt = options !== undefined && typeof options.attempt === 'number' ? options.attempt : 0
        const resolved = file === undefined ? parseSessionAddress(address) : file
        if (resolved === undefined) return
        const previous = documents.get(address)
        const cached = previous === undefined
          ? { status: 'absent', text: undefined, version: undefined, absolutePath: undefined }
          : previous
        const observedValue = observed.get(address)
        const knownVersion = observedValue === undefined || observedValue.value === undefined ? undefined : observedValue.value.version
        if (!force && cached.status === 'loading') return
        if (!force && cached.status === 'ready' && (knownVersion === undefined || cached.version === knownVersion)) return
        const running = active.get(address)
        if (running !== undefined) running.abort()
        const controller = new AbortController()
        active.set(address, controller)
        documents.set(address, { status: 'loading', text: cached.text, version: cached.version, absolutePath: cached.absolutePath })
        publish()
        readDocument(resolved.sessionId, resolved.path, controller.signal).then((result) => {
          if (controller.signal.aborted || active.get(address) !== controller) return
          active.delete(address)
          if (result.aborted === true) return
          const latest = observed.get(address)
          const latestVersion = latest === undefined || latest.value === undefined ? undefined : latest.value.version
          const raced = result.mixed === true
            || (latestVersion !== undefined && result.version !== undefined && latestVersion !== result.version)
          if (raced && attempt < 2) {
            load(address, resolved, { force: true, attempt: attempt + 1 })
            return
          }
          if (result.text !== undefined && result.failure === undefined && result.mixed !== true) {
            outlines.set(address, { version: result.version, headings: parseHeadings(result.text) })
          }
          documents.set(address, {
            status: result.text === undefined || result.failure !== undefined ? 'error' : 'ready',
            text: result.text,
            version: result.version,
            absolutePath: result.absolutePath,
            truncated: result.truncated,
            error: result.failure,
            changedAt: Date.now(),
          })
          publish()
        }, (thrown) => {
          if (controller.signal.aborted || active.get(address) !== controller) return
          active.delete(address)
          documents.set(address, {
            status: 'error',
            text: cached.text,
            version: cached.version,
            absolutePath: cached.absolutePath,
            error: { code: 'gateway/internal', message: thrown instanceof Error ? thrown.message : String(thrown) },
            changedAt: Date.now(),
          })
          publish()
        })
      }

      /**
       * Load an address only when the cache cannot answer for the observed version.
       * @param address - resource address.
       * @param options - `force` for an explicit reload.
       */
      const ensure = (address, options) => {
        const force = options !== undefined && options.force === true
        if (!force && active.has(address)) return
        load(address, undefined, { force })
      }

      /**
       * Record one `file` resource snapshot from the panel's standard hook.
       * A newer version of a document already on screen re-reads it; a read
       * that meets a newer version is caught again at settlement time.
       * @param address - resource address.
       * @param meta - `{ status, value, failure }` from `useResource`.
       */
      const observe = (address, meta) => {
        if (meta === undefined || meta === null || typeof meta !== 'object') return
        observed.set(address, { status: meta.status, value: meta.value, failure: meta.failure })
        const version = meta.value === undefined || meta.value === null ? undefined : meta.value.version
        const cached = documents.get(address)
        if (cached === undefined) return
        if (version !== undefined && cached.status === 'ready' && cached.version !== version) {
          load(address, undefined, { force: true })
          return
        }
        if (cached.status === 'error' && version !== undefined) load(address, undefined, { force: false })
      }

      /** Reconcile the catalogs against the Sidebar's open-tab inventory. */
      const sync = () => {
        if (disposed) return
        let tabs = []
        try {
          tabs = ctx.sidebarRight.openTabs.getSnapshot() || []
        } catch (_unavailable) {
          tabs = []
        }
        let changed = false
        for (const tab of tabs) {
          if (tab === null || tab === undefined || tab.kind !== KIND) continue
          const file = parseSessionAddress(tab.contentId)
          if (file === undefined) continue
          let map = sessions.get(tab.sessionId)
          if (map === undefined) {
            map = new Map()
            sessions.set(tab.sessionId, map)
          }
          if (map.has(tab.contentId)) continue
          map.set(tab.contentId, {
            address: tab.contentId,
            sessionId: file.sessionId,
            sidebarSessionId: tab.sessionId,
            path: file.path,
            name: basenameOf(file.path),
            order: (order += 1),
          })
          changed = true
          ensure(tab.contentId)
        }
        if (changed) {
          prune()
          publish()
        }
      }

      /** Forget everything a disposed plugin owned. */
      const dispose = () => {
        disposed = true
        for (const controller of active.values()) controller.abort()
        active.clear()
        sessions.clear()
        documents.clear()
        outlines.clear()
        observed.clear()
        listeners.clear()
      }

      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        getSnapshot() {
          return snapshot
        },
        entriesFor(sessionId) {
          const map = sessions.get(sessionId)
          if (map === undefined) return []
          return [...map.values()].sort((left, right) => left.order - right.order)
        },
        entryOf(address) {
          for (const map of sessions.values()) {
            const entry = map.get(address)
            if (entry !== undefined) return entry
          }
          return undefined
        },
        allEntries() {
          const byAddress = new Map()
          for (const map of sessions.values()) {
            for (const entry of map.values()) {
              const held = byAddress.get(entry.address)
              if (held === undefined || held.order < entry.order) byAddress.set(entry.address, entry)
            }
          }
          return [...byAddress.values()].sort((left, right) => left.order - right.order)
        },
        observe,
        ensure,
        reload(address) {
          load(address, undefined, { force: true })
        },
        docOf(address) {
          return documents.get(address)
        },
        headingsOf(address) {
          const outline = outlines.get(address)
          return outline === undefined ? undefined : outline.headings
        },
        sync,
        dispose,
      }
    }

    // ------------------------------------------------------------ panel UI

    /** Persisted panel preferences: outline visibility and collapsed tree nodes. */
    function createUiState() {
      const initial = { collapsed: {}, selections: {}, plans: {} }
      try {
        const raw = localStorage.getItem(UI_KEY)
        if (raw !== null && raw !== undefined) {
          const parsed = JSON.parse(raw)
          if (parsed !== null && typeof parsed === 'object') {
            if (parsed.collapsed !== null && typeof parsed.collapsed === 'object') initial.collapsed = parsed.collapsed
          }
        }
      } catch (_unavailable) { /* Storage is optional; the defaults stay usable. */ }
      let state = initial
      let snapshot = state
      const listeners = new Set()
      const scrollPositions = new Map()
      const persist = () => {
        try {
          localStorage.setItem(UI_KEY, JSON.stringify(state))
        } catch (_unavailable) { /* A full or disabled store keeps the in-memory state. */ }
      }
      const publish = () => {
        snapshot = state
        for (const listener of [...listeners]) listener()
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        getSnapshot() {
          return snapshot
        },
        collapsed(key) {
          return snapshot.collapsed[key] === true
        },
        toggleNode(key) {
          const collapsed = { ...state.collapsed }
          if (collapsed[key] === true) delete collapsed[key]
          else collapsed[key] = true
          state = { ...state, collapsed }
          persist()
          publish()
        },
        selectionOf(sessionId) {
          return snapshot.selections[sessionId]
        },
        selectDocument(sessionId, address, line) {
          state = {
            ...state,
            selections: { ...state.selections, [sessionId]: { address, line } },
          }
          publish()
        },
        plansOf(sessionId) {
          return snapshot.plans[sessionId] === undefined ? [] : snapshot.plans[sessionId]
        },
        addPlan(sessionId, address) {
          const plans = snapshot.plans[sessionId] === undefined ? [] : snapshot.plans[sessionId]
          if (plans.some((plan) => plan.address === address)) return
          state = {
            ...state,
            plans: { ...state.plans, [sessionId]: [...plans, { address }] },
          }
          publish()
        },
        setPlanMeta(address, meta) {
          let changed = false
          const plans = {}
          for (const [sessionId, list] of Object.entries(state.plans)) {
            const next = list.map((plan) => {
              if (plan.address !== address) return plan
              const merged = { address, title: plan.title, headings: plan.headings }
              if (meta.title !== undefined) merged.title = meta.title
              if (meta.headings !== undefined) merged.headings = meta.headings
              if (merged.title === plan.title && merged.headings === plan.headings) return plan
              changed = true
              return merged
            })
            plans[sessionId] = next
          }
          if (!changed) return
          state = { ...state, plans }
          publish()
        },
        scrollOf(address) {
          const value = scrollPositions.get(address)
          return value === undefined ? 0 : value
        },
        rememberScroll(address, top) {
          if (scrollPositions.size > 200 && !scrollPositions.has(address)) {
            const oldest = scrollPositions.keys().next()
            if (oldest.done !== true) scrollPositions.delete(oldest.value)
          }
          scrollPositions.set(address, top)
        },
      }
    }

    const SVG = {
      chevron(variant) {
        return h('svg', {
          viewBox: '0 0 16 16',
          width: 12,
          height: 12,
          'aria-hidden': true,
          className: `mo-chevron${variant ? ` mo-chevron-${variant}` : ''}`,
        }, h('path', {
          d: 'M6 3.5 10.5 8 6 12.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }))
      },
      plan() {
        return h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true },
          h('rect', { x: 3, y: 2.5, width: 10, height: 11, rx: 1.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
          h('path', { d: 'M5.5 6h5M5.5 8.5h5M5.5 11h3', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }))
      },
      markdown() {
        return h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true, className: 'mo-row-icon mo-row-icon-md' },
          h('rect', { x: 2.7, y: 2.2, width: 10.6, height: 11.6, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
          h('path', { d: 'M5 10.4V6.2l1.7 2 1.7-2v4.2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
          h('path', { d: 'M10.2 6.6v3.2M9.2 8.8l1 1 1-1', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }))
      },
      markdownChip() {
        return h('span', {
          style: {
            display: 'inline-flex',
            flex: '0 0 auto',
            alignItems: 'center',
            justifyContent: 'center',
            width: 16,
            height: 16,
            marginRight: 6,
            color: 'var(--dsw-alias-brand-primary)',
          },
        }, h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true },
          h('rect', { x: 2.6, y: 2.2, width: 10.8, height: 11.6, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
          h('path', { d: 'M5 10.4V6.2l1.7 2 1.7-2v4.2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
          h('path', { d: 'M10.2 6.6v3.2M9.2 8.8l1 1 1-1', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' })))
      },
      heading() {
        return h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true, className: 'mo-row-icon' },
          h('path', { d: 'M4.5 3.5v9M11.5 3.5v9M4.5 8h7', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))
      },
    }

    /**
     * One Session's document list: its plans and opened Markdown files, then
     * each document's headings. A file row opens the document, while its
     * chevron toggles only its headings.
     */
    function OutlineRail(props) {
      const {
        files, activeAddress, activeLine, collapsedOf, onToggleNode, onOpenFile, onOpenHeading,
        headingsOf, loadingOf, width, fileCount, labels, onClose,
      } = props
      const rows = []
      const toggleLabel = (collapsed) => (collapsed ? labels.expand : labels.collapse)
      for (const entry of files) {
        const fileKey = `f:${entry.address}`
        const fileCollapsed = collapsedOf(fileKey)
        const active = entry.address === activeAddress
        const headings = headingsOf(entry.address)
        const loading = loadingOf(entry.address)
        const hasChildren = headings === undefined ? loading : headings.length > 0
        rows.push(h('div', {
          key: fileKey,
          className: 'mo-row mo-row-file',
          'data-active': active ? 'true' : undefined,
        },
          hasChildren
            ? h('button', {
              type: 'button',
              className: 'mo-rowtoggle',
              onClick: (event) => {
                event.stopPropagation()
                onToggleNode(fileKey)
              },
              title: toggleLabel(fileCollapsed),
              'aria-label': `${toggleLabel(fileCollapsed)} ${entry.name}`,
              'aria-expanded': !fileCollapsed,
            }, h('span', { className: 'mo-chevronbox' }, SVG.chevron(fileCollapsed ? undefined : 'open')))
            : h('span', { className: 'mo-chevronbox' }),
          h('button', {
            type: 'button',
            className: 'mo-rowbody',
            onClick: () => onOpenFile(entry.address),
            title: entry.path,
            'aria-current': active ? 'true' : undefined,
          },
            entry.plan === true ? SVG.plan() : SVG.markdown(),
            h('span', { className: 'mo-row-label' }, entry.name),
            entry.hint === undefined || entry.hint === ''
              ? null
              : h('span', { className: 'mo-row-dir', title: entry.path === '' ? entry.hint : dirnameOf(entry.path) }, entry.hint),
            loading ? h('span', { className: 'mo-row-badge' }, '…') : null)))
        if (fileCollapsed) continue
        if (headings === undefined) {
          if (loading) {
            rows.push(h('div', { key: `${fileKey}-pending`, className: 'mo-row mo-row-hint' }, labels.loading))
          }
          continue
        }
        for (let index = 0; index < headings.length; index += 1) {
          const heading = headings[index]
          const isActive = active && heading.line === activeLine
          rows.push(h('button', {
            key: `${fileKey}-h${heading.line}-${index}`,
            type: 'button',
            className: 'mo-row mo-row-heading',
            style: { paddingLeft: 26 + Math.min(heading.level - 1, 4) * 12 },
            onClick: () => {
              onOpenHeading(entry.address, heading.line)
            },
            title: `H${heading.level} ${heading.text}`,
            'data-active': isActive ? 'true' : undefined,
            'data-level': String(heading.level),
          },
            h('span', { className: 'mo-row-headingmark', 'data-level': String(heading.level) }, `H${heading.level}`),
            h('span', { className: 'mo-row-label' }, heading.text)))
        }
      }
      return h('aside', { className: 'mo-tree', style: { width } },
        h('div', { className: 'mo-tree-head' },
          h('span', { className: 'mo-tree-title' }, labels.title),
          h('span', { className: 'mo-tree-count', title: format(labels.count, { count: fileCount }) }, String(fileCount)),
          onClose === undefined ? null : h('button', {
            type: 'button',
            className: 'mo-tree-close',
            onClick: onClose,
            title: labels.close,
            'aria-label': labels.close,
          }, '×')),
        h('div', { className: 'mo-tree-scroll' }, ...(rows.length === 0
          ? [h('p', { key: 'empty', className: 'mo-tree-empty' }, labels.empty)]
          : rows)))
    }

    /**
     * One document inside the Session view: the file's Markdown read through the
     * shared catalog and the standard resource hook, so it reloads when the file
     * changes on disk.
     * @param props - resource address, resource hook, copy, and selection target.
     */
    function PageDocument(props) {
      const { address, useResource, t, line, select } = props
      const meta = useResource(address)
      const file = parseSessionAddress(address)
      const scrollRef = useRef(null)
      const doc = catalog.docOf(address)
      const headings = catalog.headingsOf(address)
      const version = meta !== undefined && meta !== null && meta.value !== undefined ? meta.value.version : undefined

      useEffect(() => {
        catalog.observe(address, meta)
      }, [address, meta])

      useEffect(() => {
        catalog.ensure(address)
      }, [address])

      useEffect(() => {
        if (version !== undefined) catalog.ensure(address)
      }, [address, version])

      // Reveal the line the tree asked for once the content is in place.
      useEffect(() => {
        const element = scrollRef.current
        if (line === undefined || element === null) return
        const target = element.querySelector(`[data-md-line="${line}"]`)
        if (target !== null) element.scrollTop = Math.max(0, target.offsetTop - 12)
      }, [address, line, doc === undefined ? undefined : doc.version])

      const resolveImage = useCallback((destination) => {
        if (typeof destination !== 'string' || destination.length === 0) return undefined
        const suffix = destination.search(/[?#]/)
        let raw
        try {
          raw = decodeURIComponent(suffix === -1 ? destination : destination.slice(0, suffix))
        } catch (_malformed) {
          return undefined
        }
        if (/^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('//')) {
          return /^(?:https?):/i.test(raw) ? raw : undefined
        }
        const absolutePath = meta !== undefined && meta !== null && meta.value !== undefined
          ? meta.value.absolutePath
          : doc === undefined ? undefined : doc.absolutePath
        let resolved
        if (raw.startsWith('/')) resolved = raw
        else if (absolutePath !== undefined) resolved = dirnameOf(absolutePath) + raw
        else if (file !== undefined) resolved = dirnameOf(file.path) + raw
        if (resolved === undefined) return undefined
        try {
          return new URL(`api/file?path=${encodeURIComponent(resolved)}`, document.baseURI).href
        } catch (_unavailable) {
          return undefined
        }
      }, [meta, doc, file])

      const scrollToLine = useCallback((target) => {
        const element = scrollRef.current
        if (element === null) return
        const found = element.querySelector(`[data-md-line="${target}"]`)
        if (found !== null) element.scrollTop = Math.max(0, found.offsetTop - 12)
      }, [])

      const openLink = useCallback((href) => {
        if (typeof href !== 'string' || href.length === 0) return
        if (href.startsWith('#')) {
          if (href.length > 1) {
            const slug = href.slice(1).toLowerCase()
            const found = headings === undefined ? undefined : headings.find((heading) => slugify(heading.text) === slug)
            if (found !== undefined) scrollToLine(found.line)
          }
          return
        }
        if (/^(?:https?|mailto):/i.test(href)) {
          try {
            window.open(href, '_blank', 'noopener')
          } catch (_blocked) { /* A blocked popup leaves the link inert. */ }
          return
        }
        if (file === undefined) return
        const resolved = resolveRelativePath(dirnameOf(file.path), href)
        if (resolved === undefined) return
        select(sessionFileAddress(file.sessionId, resolved))
      }, [file, headings, scrollToLine, select])

      const metaFailure = meta !== undefined && meta !== null && meta.status === 'failed' ? meta.failure : undefined
      const failure = doc === undefined ? undefined : doc.error
      const notice = failure === undefined ? metaFailure : failure
      const labels = { title: t('md.copy'), copied: t('md.copied'), language: t('md.language') }

      const absolutePath = meta !== undefined && meta !== null && meta.value !== undefined
        ? meta.value.absolutePath
        : doc === undefined ? undefined : doc.absolutePath
      const displayPath = absolutePath !== undefined ? absolutePath : file === undefined ? address : file.path
      const title = file === undefined ? address : basenameOf(file.path)

      let body
      const hasText = doc !== undefined && typeof doc.text === 'string' && doc.text.length > 0
      if (doc === undefined) {
        body = metaFailure === undefined
          ? h('div', { className: 'mo-state' }, h('span', { className: 'mo-spinner', 'aria-hidden': true }), h('span', null, t('state.loading')))
          : h('div', { className: 'mo-state mo-state-error' },
            h('p', { className: 'mo-error' }, errorCopy(t, metaFailure.code, metaFailure.message)))
      } else if (hasText) {
        body = h('div', { className: 'mo-scroll', ref: scrollRef, tabIndex: -1 },
          doc.truncated === true ? h('p', { className: 'mo-note' }, t('state.truncated')) : null,
          h('article', { className: 'mo-doc' },
            h(MarkdownDocument, { text: doc.text, resolveImage, openLink, labels, frontmatterLabel: t('md.frontmatter') })),
          notice === undefined ? null : h('div', { className: 'mo-inline-error' },
            h('span', null, errorCopy(t, notice.code, notice.message))))
      } else if (doc.status === 'error' || metaFailure !== undefined) {
        body = h('div', { className: 'mo-state mo-state-error' },
          h('p', { className: 'mo-error' }, errorCopy(t, notice === undefined ? undefined : notice.code, notice === undefined ? undefined : notice.message)))
      } else {
        body = h('div', { className: 'mo-state' }, h('span', null, t('state.empty')))
      }

      return h('section', { className: 'mo-page-doc' },
        h('div', { className: 'mo-head' },
          h('div', { className: 'mo-heading' },
            h('span', { className: 'mo-title', title: displayPath }, title),
            h('span', { className: 'mo-sub', title: displayPath }, displayPath))),
        body)
    }

    /**
     * One plan document: the Markdown a submitted plan holds, read through the
     * plan resource provider, with its title and headings fed back to the tree.
     * @param props - plan address, resource hook, and copy.
     */
    function PlanDocument(props) {
      const { address, useResource, t } = props
      const meta = useResource(address)
      const scrollRef = useRef(null)
      const value = meta !== undefined && meta !== null && meta.value !== undefined ? meta.value : undefined
      const markdown = value !== undefined && typeof value.markdown === 'string' ? value.markdown : undefined
      const title = value !== undefined && typeof value.title === 'string' ? value.title : undefined
      const headings = useMemo(() => markdown === undefined ? undefined : parseHeadings(markdown), [markdown])

      useEffect(() => {
        if (title === undefined && headings === undefined) return
        ui.setPlanMeta(address, { title, headings })
      }, [address, title, headings])

      const openLink = useCallback((href) => {
        if (typeof href !== 'string' || !/^(?:https?|mailto):/i.test(href)) return
        try {
          window.open(href, '_blank', 'noopener')
        } catch (_blocked) { /* A blocked popup leaves the link inert. */ }
      }, [])

      const failure = meta !== undefined && meta !== null && meta.status === 'failed' ? meta.failure : undefined
      let body
      if (markdown !== undefined && markdown.length > 0) {
        body = h('div', { className: 'mo-scroll', ref: scrollRef, tabIndex: -1 },
          h('article', { className: 'mo-doc' },
            h(MarkdownDocument, {
              text: markdown,
              openLink,
              labels: { title: t('md.copy'), copied: t('md.copied'), language: t('md.language') },
              frontmatterLabel: t('md.frontmatter'),
            })))
      } else if (failure !== undefined) {
        body = h('div', { className: 'mo-state mo-state-error' },
          h('p', { className: 'mo-error' }, errorCopy(t, failure.code, failure.message)))
      } else if (value !== undefined) {
        body = h('div', { className: 'mo-state' }, h('span', null, t('state.empty')))
      } else {
        body = h('div', { className: 'mo-state' }, h('span', { className: 'mo-spinner', 'aria-hidden': true }), h('span', null, t('state.loading')))
      }

      return h('section', { className: 'mo-page-doc' },
        h('div', { className: 'mo-head' },
          h('div', { className: 'mo-heading' },
            h('span', { className: 'mo-title', title: address }, title === undefined ? t('outline.planName') : title),
            h('span', { className: 'mo-sub' }, t('outline.planName')))),
        body)
    }

    /**
     * The Session's Markdown documents view, shown beside the Conversation:
     * the plans and markdown files opened in this Session, flat (no workspace
     * level), with the selected document on the right.
     * @param props - Session standard props and locale.
     */
    function SessionDocumentsView(props) {
      const { sessionId, useResource, t: localeT } = props
      const t = typeof localeT === 'function' ? localeT : boundT
      const catalogSnapshot = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot)
      const uiSnapshot = useSyncExternalStore(ui.subscribe, ui.getSnapshot)
      const selection = sessionId === undefined ? undefined : uiSnapshot.selections[sessionId]
      const plans = sessionId === undefined ? [] : (uiSnapshot.plans[sessionId] === undefined ? [] : uiSnapshot.plans[sessionId])
      const files = useMemo(() => {
        if (sessionId === undefined) return []
        return catalog.entriesFor(sessionId).map((entry) => ({
          address: entry.address,
          name: entry.name,
          path: entry.path,
          hint: entry.hint,
          order: entry.order,
        }))
      }, [catalogSnapshot.revision, sessionId])
      const rows = useMemo(() => {
        const out = plans.map((plan) => ({
          address: plan.address,
          name: plan.title === undefined ? t('outline.planName') : plan.title,
          path: '',
          hint: plan.title === undefined ? '' : t('outline.planName'),
          plan: true,
          order: 0,
        }))
        for (const file of files) out.push(file)
        return out
      }, [plans, files, t])
      const headingsOf = (address) => {
        const plan = plans.find((item) => item.address === address)
        if (plan !== undefined) return plan.headings
        return catalog.headingsOf(address)
      }
      const loadingOf = (address) => {
        if (plans.some((item) => item.address === address)) return false
        const cached = catalog.docOf(address)
        return cached === undefined || cached.status === 'loading'
      }
      const select = (address, line) => ui.selectDocument(sessionId, address, line)
      const openFile = (address) => select(address)
      const openHeading = (address, line) => select(address, line)
      const selected = selection === undefined ? undefined : selection.address
      return h('div', { className: 'mo-page', 'data-conversation-composer-overlay': '' },
        h('style', null, CSS),
        h('div', { className: 'mo-page-rail' },
          h(OutlineRail, {
            files: rows,
            activeAddress: selected,
            activeLine: selection === undefined ? undefined : selection.line,
            collapsedOf: ui.collapsed,
            onToggleNode: ui.toggleNode,
            onOpenFile: openFile,
            onOpenHeading: openHeading,
            headingsOf,
            loadingOf,
            width: '100%',
            fileCount: rows.length,
            labels: {
              title: t('outline.title'),
              count: t('tree.count'),
              empty: t('tree.empty'),
              loading: t('tree.loading'),
              expand: t('tree.expand'),
              collapse: t('tree.collapse'),
            },
          })),
        selected === undefined
          ? h('div', { className: 'mo-page-empty' }, h('span', null, t('tree.empty')))
          : (parsePlanAddress(selected) === undefined
            ? h(PageDocument, { key: selected, address: selected, useResource, t, line: selection.line, select })
            : h(PlanDocument, { key: selected, address: selected, useResource, t })))
    }

    /**
     * A Markdown link opened from a conversation asks for a reading pane; this
     * Session's preview view is that pane now, so the tab hands the document to
     * the view and closes itself.
     * @param props - tab information hook and the Session standard prop.
     */
    /**
     * Select this plugin's own Conversation View tab in the Session header.
     * The shell keeps the selected View in its Session store and hands the
     * selector only to its own header, so the header's button is clicked here.
     * @returns whether the tab was found and clicked.
     */
    function focusSessionViewTab() {
      if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return false
      const label = boundT('outline.title')
      const header = document.querySelector('header')
      if (header === null) return false
      for (const element of header.querySelectorAll('button, [role="tab"]')) {
        const text = element.textContent
        if (typeof text !== 'string' || !text.includes(label)) continue
        element.click()
        return true
      }
      return false
    }

    function MarkdownLinkRedirect(props) {
      const { useTabInfo, sessionId } = props
      const info = useTabInfo()
      const tab = info.tab
      const address = tab.contentId
      const params = tab.navigation === undefined ? undefined : tab.navigation.params
      const line = params !== undefined && params !== null && typeof params.line === 'number' ? params.line : undefined
      useEffect(() => {
        if (parsePlanAddress(address) !== undefined) ui.addPlan(sessionId, address)
        ui.selectDocument(sessionId, address, line)
        try {
          pluginCtx.uiConversation.binding(sessionId).activate(ID)
        } catch (_unavailable) { /* The Session owns the view state. */ }
        focusSessionViewTab()
        try {
          tab.actions.close()
        } catch (_unavailable) { /* The record may already be gone. */ }
      }, [address])
      return null
    }

    /**
     * The tab's chip title: the Markdown glyph before the name captured when
     * the tab opened, matching the built-in file tabs.
     * @param props - the framework-bound tab information hook.
     * @returns the chip content.
     */
    function MarkdownTitle({ useTabInfo }) {
      const info = useTabInfo()
      return h(React.Fragment, null, SVG.markdownChip(), info.tab.title)
    }

    /**
     * Localized failure line for a workspace-file read.
     * @param t - translate function.
     * @param code - remote error code.
     * @param message - remote error message.
     * @returns the copy shown to the reader.
     */
    function errorCopy(t, code, message) {
      if (code === 'workspace-file/not-found') return t('error.notFound')
      if (code === 'workspace-file/too-large') return t('error.tooLarge')
      if (code === 'workspace-file/not-text') return t('error.notText')
      if (code === 'workspace-file/not-regular-file') return t('error.notRegularFile')
      if (code === 'workspace-file/unknown-workspace' || code === 'workspace-file/unsupported-address') return t('error.resource')
      return format(t('error.unavailable'), { message: typeof message === 'string' ? message : String(code) })
    }

    // ----------------------------------------------------------------- CSS

    const CSS = `
.mo-root{position:relative;display:flex;flex:1 1 auto;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:var(--dsw-font-markdown-base)}
.mo-tree{display:flex;flex:0 0 auto;flex-direction:column;min-width:0;min-height:0;border-right:.5px solid var(--dsw-alias-border-l1)}
.mo-tree-head{display:flex;flex:0 0 auto;align-items:center;gap:8px;box-sizing:border-box;height:38px;padding:0 10px 0 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;letter-spacing:.02em;text-transform:uppercase}
.mo-tree-title{font-weight:600;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.mo-tree-count{margin-left:auto;padding-left:8px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mo-tree-scroll{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;padding:6px 4px 16px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}
.mo-tree-empty{margin:12px 10px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.mo-page{display:flex;flex-direction:row;width:100%;height:100%;max-height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:var(--dsw-font-markdown-base)}
.mo-page-rail{display:flex;flex:0 0 auto;flex-direction:column;width:300px;min-width:0;min-height:0;border-right:.5px solid var(--dsw-alias-border-l1)}
.mo-page-rail .mo-tree{width:100%;flex:1 1 auto;min-height:0;border-right:0}
.mo-page-rail .mo-tree-head{height:44px;padding:0 16px;font-size:12px}
.mo-page-rail .mo-tree-scroll{padding:8px 8px calc(var(--dsh-composer-height, 152px) + 8px)}
.mo-page-doc{display:flex;flex:1 1 auto;flex-direction:column;min-width:0;min-height:0}
.mo-page-doc .mo-doc{padding-bottom:calc(var(--dsh-composer-height, 152px) + 16px)}
.mo-page-doc .mo-scroll{overscroll-behavior:contain}
.mo-page-empty{display:flex;flex:1 1 auto;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:12px}
.mo-page .mo-row-workspace{font-size:12.5px}
.mo-page .mo-row-session,.mo-page .mo-row-file,.mo-page .mo-row-heading{font-size:12.5px;line-height:19px}
.mo-row{display:flex;align-items:center;gap:4px;box-sizing:border-box;width:100%;min-width:0;margin:0;padding:4px 8px 4px 6px;border:0;border-radius:var(--dsw-radius-sm);background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;-webkit-appearance:none;appearance:none}
.mo-row:hover{background:var(--dsw-alias-bg-layer-2)}
.mo-row:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))}
.mo-row[data-active='true']{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.mo-rowtoggle{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;box-sizing:border-box;width:16px;height:18px;margin:0;padding:0;border:0;border-radius:var(--dsw-radius-xs, 4px);background:none;color:inherit;cursor:pointer;-webkit-appearance:none;appearance:none}
.mo-rowtoggle:hover{color:var(--dsw-alias-label-primary)}
.mo-rowtoggle:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))}
.mo-rowbody{display:flex;flex:1 1 auto;align-items:center;gap:4px;min-width:0;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;-webkit-appearance:none;appearance:none}
.mo-rowbody:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))}
.mo-chip{flex:0 0 auto;margin-right:4px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:16px;white-space:nowrap}
.mo-row-workspace{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;line-height:18px}
.mo-row-session{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.mo-row-file{color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
.mo-row-heading{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px}
.mo-row-heading:hover{color:var(--dsw-alias-label-primary)}
.mo-row-heading[data-active='true']{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.mo-row-heading[data-active='true'] .mo-row-headingmark{color:var(--dsw-alias-brand-primary)}
.mo-row-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;cursor:default}
.mo-row-label{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.mo-row-count{margin-left:auto;padding-left:6px;color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:500}
.mo-row-badge{margin-left:auto;padding-left:6px;color:var(--dsw-alias-label-tertiary);font-size:10px}
.mo-rowaction{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;width:20px;height:20px;margin-left:auto;padding:0;border:0;border-radius:var(--dsw-radius-xs, 4px);background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.mo-rowaction:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mo-rowaction:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))}
.mo-row-dir{margin-left:auto;padding-left:6px;max-width:48%;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:10px;white-space:nowrap;text-overflow:ellipsis}
.mo-row-icon{flex:0 0 auto;color:var(--dsw-alias-label-tertiary)}
.mo-row-icon-md{color:var(--dsw-alias-brand-primary)}
.mo-row-headingmark{flex:0 0 auto;width:18px;color:var(--dsw-alias-label-tertiary);font-size:9px;font-weight:600;letter-spacing:.02em}
.mo-chevronbox{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;width:12px;color:var(--dsw-alias-label-tertiary)}
.mo-chevron{transition:transform .12s var(--ds-ease-in-out, ease)}
.mo-chevron-open{transform:rotate(90deg)}
.mo-main{display:flex;flex:1 1 auto;flex-direction:column;min-width:0;min-height:0}
.mo-head{display:flex;flex:0 0 auto;align-items:center;gap:4px;box-sizing:border-box;height:38px;padding:0 6px 0 8px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.mo-heading{display:flex;flex:1 1 auto;flex-direction:column;min-width:0;margin:0 4px}
.mo-title{overflow:hidden;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:17px;white-space:nowrap;text-overflow:ellipsis}
.mo-sub{overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px;white-space:nowrap;text-overflow:ellipsis;}
.mo-iconbtn{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;-webkit-appearance:none;appearance:none}
.mo-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mo-iconbtn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))}
.mo-iconbtn[data-active='true']{color:var(--dsw-alias-label-primary)}
.mo-scroll{position:relative;flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;overflow-anchor:none;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}
.mo-scroll:focus{outline:none}
.mo-doc{position:relative;box-sizing:border-box;min-width:0;max-width:860px;margin:0 auto;padding:16px 16px 48px}
.mo-state{display:flex;flex:1 1 auto;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:32px 20px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;text-align:center}
.mo-state-error{color:var(--dsw-alias-label-secondary)}
.mo-error{margin:0;max-width:320px}
.mo-note{margin:12px 16px 0;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px}
.mo-inline-error{display:flex;align-items:center;gap:10px;margin:0 20px 24px;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px}
.mo-button{flex:0 0 auto;padding:4px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;cursor:pointer}
.mo-button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mo-button:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))}
.mo-spinner{width:14px;height:14px;border:1.5px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:mo-spin .8s linear infinite}
@keyframes mo-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.mo-spinner{animation:none}.mo-chevron{transition:none}}
.mo-md{min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.mo-md>*:first-child{margin-top:0}
.mo-md>*:last-child{margin-bottom:0}
.mo-md h1{font:var(--dsw-font-markdown-h1);margin:32px 0 16px}
.mo-md h2{font:var(--dsw-font-markdown-h2);margin:32px 0 16px}
.mo-md h3{font:var(--dsw-font-markdown-h3);margin:32px 0 16px}
.mo-md h4{font:var(--dsw-font-markdown-h4);margin:16px 0}
.mo-md h5,.mo-md h6{font:var(--dsw-font-markdown-base-strong);margin:16px 0}
.mo-md p{margin:16px 0}
.mo-md strong{font-weight:600}
.mo-md a{color:var(--dsw-alias-link);font-weight:500;text-decoration:none;cursor:pointer}
.mo-md a:hover,.mo-md a:focus-visible{text-decoration:underline dotted var(--dsw-alias-link);text-underline-offset:3px;outline:none}
.mo-md ul,.mo-md ol{margin:16px 0;padding-left:20px}
.mo-md li{margin:6px 0}
.mo-md li::marker{color:var(--dsw-alias-label-secondary)}
.mo-md li>ul,.mo-md li>ol{margin:4px 0}
.mo-md li>p{margin:6px 0}
.mo-md li.mo-md-task{list-style:none;margin-left:-18px;display:flex;align-items:flex-start;gap:6px}
.mo-md li.mo-md-task>span{min-width:0}
.mo-md li.mo-md-task>input{margin:5px 0 0;flex:0 0 auto}
.mo-md blockquote{margin:16px 0 0;padding:2px 0 2px 14px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.mo-md blockquote p{margin:6px 0}
.mo-md hr{height:.5px;margin:32px 0;border:0;background:var(--dsw-alias-border-l2)}
.mo-md code{font-family:var(--ds-font-family-code);font-size:.9em}
.mo-md :not(pre)>code{padding:0 5px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-markdown-inline-code);font:var(--dsw-font-markdown-code, inherit);font-family:var(--ds-font-family-code);font-size:.875em;box-decoration-break:clone}
.mo-md-code{margin:14px 0;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);overflow:hidden;background:var(--dsw-alias-bg-layer-2)}
.mo-md-code-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 6px 2px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:24px;letter-spacing:.02em}
.mo-md-code-lang{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;text-transform:uppercase}
.mo-md-copy{padding:2px 8px;border:0;border-radius:var(--dsw-radius-xs, 4px);background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10px;cursor:pointer}
.mo-md-copy:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mo-md-copy:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))}
.mo-md-code pre{margin:0;padding:10px 12px;overflow:auto;font-family:var(--ds-font-family-code);font-size:12px;line-height:1.65;white-space:pre}
.mo-md-tablewrap{margin:14px 0;max-width:100%;overflow-x:auto}
.mo-md table{border-collapse:collapse;width:max-content;max-width:100%;font:var(--dsw-font-markdown-table)}
.mo-md th{padding:10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2);font:var(--dsw-font-markdown-table-head);text-align:left;vertical-align:top}
.mo-md td{padding:10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l1);text-align:left;vertical-align:top}
.mo-md th:last-child,.mo-md td:last-child{padding-right:0}
.mo-md th:first-child,.mo-md td:first-child{padding-left:0}
.mo-md>.mo-md-tablewrap>table code{font-size:11px}
.mo-md-img{display:block;max-width:100%;height:auto;margin:10px 0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.mo-md-alt{color:var(--dsw-alias-label-tertiary);font-style:italic}
.mo-md-frontmatter{margin:0 0 20px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);font:var(--dsw-font-markdown-small, var(--dsw-font-markdown-base));font-size:12px;line-height:18px}
.mo-md-fm-title{margin-bottom:6px;color:var(--dsw-alias-label-tertiary);font-size:10px;letter-spacing:.04em;text-transform:uppercase}
.mo-md-fm-row{display:flex;gap:8px;min-width:0}
.mo-md-fm-key{flex:0 0 auto;color:var(--dsw-alias-label-tertiary)}
.mo-md-fm-value{min-width:0;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.mo-md-fm-source{margin:0;overflow:auto;color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:11px;white-space:pre-wrap}
`

    // -------------------------------------------------------------- plugin

    /** Client services this plugin requires before it activates. */
    const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'remote', 'remote.workspaceFiles', 'uiConversation']

    let catalog
    let ui
    let boundT
    let pluginCtx

    /**
     * Register the tab type, its slot body, its dictionaries, and the shared
     * catalog for the plugin's lifetime.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      pluginCtx = ctx
      boundT = ctx.locale.bind(NS)
      catalog = createCatalog(ctx)
      ui = createUiState()

      ctx.effect(() => () => catalog.dispose(), 'markdown-outline: catalog')
      ctx.effect(() => ctx.locale.register(NS, { zh, en, ja: en, es: en, fr: en, de: en, ru: en, pt: en }), 'markdown-outline: dictionaries')
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: ID,
        kind: KIND,
        patterns: ['*.md', '*.markdown', '*.mdown', '*.mdx', 'dsh-resource://plan/**'],
        priority: 'extension',
        canOpen: (address) => {
          if (parsePlanAddress(address) !== undefined) return true
          const file = parseSessionAddress(address)
          return file !== undefined && isMarkdownPath(file.path)
        },
        title: (address) => {
          if (parsePlanAddress(address) !== undefined) return boundT('outline.planName')
          const file = parseSessionAddress(address)
          return file === undefined ? boundT('tree.title') : basenameOf(file.path)
        },
      }), 'markdown-outline: tab type')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: ID,
        locale: NS,
      }, MarkdownLinkRedirect)), 'markdown-outline: tab body')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
        { name: 'sidebar.right.pane.tab.title', key: ID },
        MarkdownTitle,
      )), 'markdown-outline: tab title')
      ctx.effect(() => ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: ID,
        order: 40,
        locale: NS,
        label: () => boundT('outline.title'),
      }, SessionDocumentsView)), 'markdown-outline: session view')
      ctx.effect(() => {
        const unsubscribe = ctx.sidebarRight.openTabs.subscribe(() => { catalog.sync() })
        catalog.sync()
        return () => { unsubscribe() }
      }, 'markdown-outline: open tabs')
    }

    return {
      inject,
      apply,
      name: 'dsh-markdown-outline',
    }
  },
})
