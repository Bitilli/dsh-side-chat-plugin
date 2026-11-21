/**
 * Browser half of the Side chat plugin.
 *
 * Loaded through the DSH client module table, so React comes from the host and
 * no bundler is required. The module registers:
 *  - a selection bridge in the composer dock that renders the compact floating
 *    action bar (continue in main / ask in side);
 *  - a right-sidebar page type that lists and runs persisted side chats.
 */
window.__ModuleLoader__.load({
  id: 'dsh-side-chat-plugin',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React
    const { createPortal } = require('react-dom')

    const NS = 'sideChat'
    const API = '/api/side-chat'
    const TAB_KIND = 'side-chat'
    const TAB_ID = 'dsh-side-chat-plugin'

    const zh = {
      'tab.title': '侧边对话',
      'guide.title': '侧边对话',
      'guide.description': '选中原文后继续追问，不修改主对话',
      'bar.continue': '在主对话继续问',
      'bar.side': '在侧边问',
      'bar.close': '关闭操作栏',
      'bar.busy': '正在创建侧边对话…',
      'bar.failed': '操作失败，请重试。',
      'quote.label': '引用',
      'quote.detail': '选中片段',
      'quote.source': '引用自当前对话',
      'quote.current': '当前对话',
      'panel.empty': '还没有侧边对话',
      'panel.emptyHint': '在主对话中选中一段正文，然后选择“在侧边问”。',
      'panel.placeholder': '在侧边继续追问…',
      'panel.send': '发送',
      'panel.stop': '停止',
      'panel.retry': '重试',
      'panel.close': '关闭侧边面板',
      'panel.delete': '删除侧边对话',
      'panel.confirmDelete': '确认删除',
      'panel.backToMain': '带回主对话',
      'panel.quote': '选中原文',
      'panel.parent': '父对话',
      'panel.snapshot': '父对话上下文快照',
      'panel.snapshotMeta': '{count} 条消息 · 约 {tokens} tokens',
      'panel.truncated': '已截断 {count} 条较早消息',
      'panel.anchor': '锚点',
      'panel.running': '正在回答…',
      'panel.idle': '空闲',
      'panel.error': '回答失败',
      'panel.closed': '加载失败',
      'panel.select': '切换侧边对话',
      'panel.you': '你',
      'panel.assistant': '侧边回答',
      'panel.bringBackDone': '已插入主输入框',
      'panel.copy': '复制',
      'panel.copied': '已复制',
    }

    const en = {
      'tab.title': 'Side chat',
      'guide.title': 'Side chats',
      'guide.description': 'Ask a follow-up without changing the main conversation',
      'bar.continue': 'Continue in main',
      'bar.side': 'Ask in side',
      'bar.close': 'Dismiss actions',
      'bar.busy': 'Creating side chat…',
      'bar.failed': 'Action failed. Try again.',
      'quote.label': 'Quote',
      'quote.detail': 'Selected excerpt',
      'quote.source': 'Quoted from this conversation',
      'quote.current': 'This conversation',
      'panel.empty': 'No side chats yet',
      'panel.emptyHint': 'Select transcript text, then choose “Ask in side”.',
      'panel.placeholder': 'Ask a follow-up in this side chat…',
      'panel.send': 'Send',
      'panel.stop': 'Stop',
      'panel.retry': 'Retry',
      'panel.close': 'Close side panel',
      'panel.delete': 'Delete side chat',
      'panel.confirmDelete': 'Confirm delete',
      'panel.backToMain': 'Bring back to main',
      'panel.quote': 'Selected excerpt',
      'panel.parent': 'Parent',
      'panel.snapshot': 'Parent context snapshot',
      'panel.snapshotMeta': '{count} messages · ~{tokens} tokens',
      'panel.truncated': '{count} older messages truncated',
      'panel.anchor': 'Anchor',
      'panel.running': 'Answering…',
      'panel.idle': 'Idle',
      'panel.error': 'Answer failed',
      'panel.closed': 'Failed to load',
      'panel.select': 'Switch side chat',
      'panel.you': 'You',
      'panel.assistant': 'Side answer',
      'panel.bringBackDone': 'Inserted into the main composer',
      'panel.copy': 'Copy',
      'panel.copied': 'Copied',
    }

    const css = `
      .dsc-bar{position:fixed;z-index:80;display:flex;flex-direction:column;gap:6px;align-items:stretch;
        min-width:260px;max-width:min(360px,calc(100vw - 16px));padding:5px;border-radius:12px;
        background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);
        box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-primary);font:inherit}
      .dsc-barRow{display:flex;gap:4px;align-items:center}
      .dsc-barButton{appearance:none;border:0;cursor:pointer;background:transparent;color:inherit;
        font:inherit;font-size:13px;line-height:1.3;padding:6px 9px;border-radius:8px;white-space:nowrap}
      .dsc-barButton:hover{background:var(--dsw-alias-bg-layer-2)}
      .dsc-barButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
      .dsc-barButton[data-primary]{color:var(--dsw-alias-brand-primary);font-weight:600}
      .dsc-barClose{width:28px;justify-content:center;padding:6px 0;color:var(--dsw-alias-label-secondary)}
      .dsc-barError{font-size:12px;color:var(--dsw-alias-state-error-primary);padding:0 8px 2px}
      .dsc-barHint{font-size:11px;color:var(--dsw-alias-label-secondary);padding:0 8px 2px}
      body[data-dsh-side-bar="1"] [data-text-interaction-surface]{display:none !important}

      .dsc-panel{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font:inherit}
      .dsc-head{display:flex;align-items:center;gap:6px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
      .dsc-title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
      .dsc-status{font-size:11px;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;gap:4px;flex:none}
      .dsc-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);display:inline-block}
      .dsc-dot[data-running]{background:var(--dsw-alias-state-warn-primary)}
      .dsc-dot[data-error]{background:var(--dsw-alias-state-error-primary)}
      .dsc-iconButton{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;
        font:inherit;font-size:14px;line-height:1;padding:5px 7px;border-radius:6px;flex:none}
      .dsc-iconButton:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
      .dsc-iconButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
      .dsc-select{appearance:auto;max-width:150px;min-width:0;border:1px solid var(--dsw-alias-border-l1);
        background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:7px;
        font:inherit;font-size:12px;padding:4px 6px;flex:none}
      .dsc-scroll{flex:1;min-height:0;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:12px}
      .dsc-empty{margin:auto;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6;padding:24px 12px}
      .dsc-quote{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-brand-primary);
        background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.55}
      .dsc-quoteText{white-space:pre-wrap;overflow-wrap:anywhere;max-height:120px;overflow:auto;color:var(--dsw-alias-label-primary)}
      .dsc-meta{margin-top:5px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}
      .dsc-message{display:flex;flex-direction:column;gap:5px}
      .dsc-role{font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:6px}
      .dsc-body{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.6}
      .dsc-message[data-role="user"] .dsc-body{background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:8px 10px}
      .dsc-messageActions{display:flex;gap:4px;flex-wrap:wrap}
      .dsc-mini{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);
        cursor:pointer;font:inherit;font-size:11px;padding:3px 7px;border-radius:6px}
      .dsc-mini:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
      .dsc-mini:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
      .dsc-error{border:1px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1);
        border-radius:8px;padding:8px 10px;font-size:12px;color:var(--dsw-alias-state-error-primary);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .dsc-streaming{font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:6px}
      .dsc-foot{flex:none;border-top:1px solid var(--dsw-alias-border-l1);padding:8px 10px 10px;display:flex;flex-direction:column;gap:6px}
      .dsc-input{width:100%;box-sizing:border-box;resize:none;min-height:46px;max-height:140px;padding:8px 9px;
        border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);
        color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}
      .dsc-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
      .dsc-footRow{display:flex;gap:6px;align-items:center;justify-content:flex-end}
      .dsc-action{appearance:none;border:0;border-radius:7px;cursor:pointer;font:inherit;font-size:12px;padding:5px 10px;
        background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
      .dsc-action[data-secondary]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
      .dsc-action:disabled{opacity:.5;cursor:default}
      .dsc-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
      .dsc-note{font-size:11px;color:var(--dsw-alias-label-secondary)}
    `

    async function apiJson(path, { method = 'GET', body, signal } = {}) {
      const response = await fetch(`${API}${path}`, {
        method,
        credentials: 'same-origin',
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      })
      let payload = {}
      try {
        payload = await response.json()
      } catch {
        payload = {}
      }
      if (!response.ok) {
        const error = new Error(payload.message ?? `HTTP ${response.status}`)
        error.code = payload.code
        error.status = response.status
        throw error
      }
      return payload
    }

    function dispatchSse(block, onEvent) {
      const data = block
        .split(/\r?\n/u)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n')
      if (data === '') return
      try {
        onEvent(JSON.parse(data))
      } catch {
        // A malformed frame is ignored; the next done/error frame still settles the view.
      }
    }

    /**
     * Open one SSE request. Resolves after response headers; frames keep arriving
     * through `onEvent`. The returned controller aborts the client reader only.
     */
    async function openStream(path, body, onEvent) {
      const controller = new AbortController()
      const response = await fetch(`${API}${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        let payload = {}
        try {
          payload = await response.json()
        } catch {
          payload = {}
        }
        const error = new Error(payload.message ?? `HTTP ${response.status}`)
        error.code = payload.code
        error.status = response.status
        throw error
      }
      if (response.body === null) throw new Error('stream unavailable')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      ;(async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let index = buffer.indexOf('\n\n')
            while (index >= 0) {
              dispatchSse(buffer.slice(0, index), onEvent)
              buffer = buffer.slice(index + 2)
              index = buffer.indexOf('\n\n')
            }
          }
          if (buffer.trim() !== '') dispatchSse(buffer, onEvent)
        } catch (error) {
          if (error?.name !== 'AbortError') {
            onEvent({ type: 'client-error', error: { message: error?.message ?? String(error) } })
          }
        }
      })()
      return controller
    }

    function elementOf(node) {
      return node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement ?? null
    }

    function insideBar(node) {
      return node instanceof Element && node.closest('[data-dsh-side-bar]') !== null
    }

    /** Read the browser selection and map it to one rendered interaction source. */
    function readSelection() {
      const selection = document.getSelection()
      if (selection === null || selection.rangeCount !== 1 || selection.isCollapsed) return null
      const range = selection.getRangeAt(0)
      const start = elementOf(range.startContainer)
      const end = elementOf(range.endContainer)
      if (start === null || end === null) return null
      const source = start.closest('[data-text-interaction-source]')
      if (source === null || source === undefined || source !== end.closest('[data-text-interaction-source]')) return null
      if (!document.body.contains(source) || source.closest('[hidden],[inert],[data-text-interaction-exclude]') !== null) return null
      if (start.closest('input,textarea,select,[contenteditable="true"],button') !== null) return null
      const raw = selection.toString()
      if ([...raw.replace(/\s+/gu, '')].length < 2) return null
      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return null
      const full = source.innerText ?? source.textContent ?? ''
      let prefix
      let suffix
      let startOffset
      let endOffset
      let index = full.indexOf(raw)
      if (index >= 0) {
        startOffset = index
        endOffset = index + raw.length
        prefix = full.slice(Math.max(0, index - 48), index)
        suffix = full.slice(endOffset, endOffset + 48)
      } else {
        const normalizedFull = full.replace(/\s+/gu, ' ')
        const normalizedRaw = raw.replace(/\s+/gu, ' ').trim()
        index = normalizedFull.indexOf(normalizedRaw)
        if (index >= 0) {
          startOffset = index
          endOffset = index + normalizedRaw.length
          prefix = normalizedFull.slice(Math.max(0, index - 48), index)
          suffix = normalizedFull.slice(endOffset, endOffset + 48)
        }
      }
      const node = source.closest('[data-chat-node-key]')
      return {
        text: raw,
        prefix,
        suffix,
        startOffset,
        endOffset,
        blockId: node?.getAttribute('data-chat-node-key') ?? undefined,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        source,
        range: range.cloneRange(),
      }
    }

    function barPlacement(rect) {
      const margin = 8
      const estimatedHeight = 44
      const center = rect.left + (rect.right - rect.left) / 2
      const halfWidth = 150
      const left = Math.min(Math.max(center, halfWidth + margin), Math.max(halfWidth + margin, window.innerWidth - halfWidth - margin))
      const flip = rect.bottom + margin + estimatedHeight > window.innerHeight - margin
        && rect.top - margin - estimatedHeight > margin
      return {
        left,
        top: flip ? rect.top - margin : rect.bottom + margin,
        transform: flip ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
      }
    }

    /** Compact floating action bar surfaced for a transcript selection. */
    function SelectionBridge({ hostCtx, sessionId, inputActions, t }) {
      const [bar, setBar] = useState(null)
      const [busy, setBusy] = useState(false)
      const [failure, setFailure] = useState('')
      const barRef = useRef(null)
      const firstButtonRef = useRef(null)
      const keyboardRef = useRef(false)
      const frameRef = useRef(0)
      const infoRef = useRef(null)

      const close = useCallback(() => {
        infoRef.current = null
        setBar(null)
        setBusy(false)
        setFailure('')
        document.body.removeAttribute('data-dsh-side-bar')
      }, [])

      const update = useCallback(() => {
        if (busy) return
        if (barRef.current !== null && insideBar(document.activeElement)) return
        const info = readSelection()
        if (info === null) {
          if (infoRef.current !== null) close()
          return
        }
        infoRef.current = info
        const placement = barPlacement(info.rect)
        setBar({ ...info, ...placement })
        document.body.setAttribute('data-dsh-side-bar', '1')
        if (keyboardRef.current) {
          requestAnimationFrame(() => firstButtonRef.current?.focus({ preventScroll: true }))
        }
        keyboardRef.current = false
      }, [busy, close])

      const schedule = useCallback(() => {
        if (frameRef.current !== 0) return
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = 0
          update()
        })
      }, [update])

      useEffect(() => {
        const onPointerDown = (event) => {
          if (event.target instanceof Element && insideBar(event.target)) return
          keyboardRef.current = false
        }
        const onPointerUp = (event) => {
          if (event.target instanceof Element && insideBar(event.target)) return
          schedule()
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && infoRef.current !== null) {
            close()
            return
          }
          if (event.key === 'Shift') keyboardRef.current = true
          if (infoRef.current === null || event.altKey === false) return
          if (event.key.toLowerCase() === 'q') {
            event.preventDefault()
            void actMain()
          } else if (event.key.toLowerCase() === 's') {
            event.preventDefault()
            void actSide()
          }
        }
        const onKeyUp = (event) => {
          if (event.key === 'Shift') schedule()
        }
        const onScroll = () => {
          if (infoRef.current === null) return
          const rect = infoRef.current.range.getBoundingClientRect()
          if (rect.width === 0 && rect.height === 0) {
            close()
            return
          }
          infoRef.current.rect = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
          setBar(current => current === null ? current : { ...current, ...barPlacement(rect) })
        }
        const onResize = () => {
          if (infoRef.current === null) return
          const rect = infoRef.current.range.getBoundingClientRect()
          infoRef.current.rect = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
          setBar(current => current === null ? current : { ...current, ...barPlacement(rect) })
        }
        document.addEventListener('selectionchange', schedule)
        document.addEventListener('pointerup', onPointerUp)
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        document.addEventListener('keyup', onKeyUp)
        window.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onResize)
        return () => {
          document.removeEventListener('selectionchange', schedule)
          document.removeEventListener('pointerup', onPointerUp)
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
          document.removeEventListener('keyup', onKeyUp)
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onResize)
          if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current)
          document.body.removeAttribute('data-dsh-side-bar')
        }
      }, [close, schedule, busy])

      const clearSelection = () => {
        document.getSelection()?.removeAllRanges()
      }

      const actMain = async () => {
        const info = infoRef.current
        if (info === null || busy) return
        const text = info.text
        const sent = `${text}\n\n${t('quote.source')}`
        const summary = {
          label: t('quote.label'),
          title: t('quote.current'),
          detail: t('quote.detail'),
          body: sent,
        }
        const inserted = inputActions?.insertQuote(sent, summary) ?? false
        if (!inserted) {
          setFailure(t('bar.failed'))
          return
        }
        clearSelection()
        close()
      }

      const actSide = async () => {
        const info = infoRef.current
        if (info === null || busy) return
        setBusy(true)
        setFailure('')
        try {
          const payload = {
            parentSessionId: sessionId,
            anchorMessageId: undefined,
            quote: {
              exact: info.text,
              prefix: info.prefix,
              suffix: info.suffix,
              startOffset: info.startOffset,
              endOffset: info.endOffset,
              blockId: info.blockId,
            },
          }
          const result = await apiJson('/create', { method: 'POST', body: payload })
          const sideChatId = result?.chat?.id
          if (typeof sideChatId !== 'string') throw new Error('missing side chat id')
          const sidebar = hostCtx?.sidebarRight
          if (sidebar === undefined) throw new Error('right sidebar unavailable')
          sidebar.openTab(TAB_KIND, { params: { sideChatId } })
          clearSelection()
          close()
        } catch (error) {
          setFailure(error?.message ?? t('bar.failed'))
          setBusy(false)
        }
      }

      if (bar === null) return null
      return createPortal(
        h('div', {
          ref: barRef,
          className: 'dsc-bar',
          role: 'toolbar',
          'aria-label': t('bar.continue'),
          'data-dsh-side-bar': '',
          style: { left: `${bar.left}px`, top: `${bar.top}px`, transform: bar.transform },
          onPointerDown: event => event.preventDefault(),
        },
          h('div', { className: 'dsc-barRow' },
            h('button', {
              ref: firstButtonRef,
              type: 'button',
              className: 'dsc-barButton',
              'data-primary': '',
              'aria-keyshortcuts': 'Alt+Q',
              onPointerDown: event => event.preventDefault(),
              onClick: () => { void actMain() },
            }, `↩ ${t('bar.continue')}`),
            h('button', {
              type: 'button',
              className: 'dsc-barButton',
              'aria-keyshortcuts': 'Alt+S',
              onPointerDown: event => event.preventDefault(),
              onClick: () => { void actSide() },
            }, `◧ ${t('bar.side')}`),
            h('button', {
              type: 'button',
              className: 'dsc-barButton dsc-barClose',
              'aria-label': t('bar.close'),
              title: t('bar.close'),
              onPointerDown: event => event.preventDefault(),
              onClick: close,
            }, '×'),
          ),
          busy ? h('div', { className: 'dsc-barHint' }, t('bar.busy')) : null,
          failure === '' ? null : h('div', { className: 'dsc-barError', role: 'alert' }, failure),
          h('div', { className: 'dsc-barHint' }, 'Alt+Q / Alt+S · Esc'),
        ),
        document.body,
      )
    }

    function statusLabel(status, t) {
      if (status === 'running') return t('panel.running')
      if (status === 'error') return t('panel.error')
      return t('panel.idle')
    }

    function SideChatPanel({ hostCtx, sessionId, useTabInfo, inputActions, t }) {
      const { tab } = useTabInfo()
      const params = tab?.navigation?.params ?? {}
      const [chats, setChats] = useState([])
      const [activeId, setActiveId] = useState(typeof params.sideChatId === 'string' ? params.sideChatId : null)
      const [detail, setDetail] = useState(null)
      const [draft, setDraft] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [loading, setLoading] = useState(true)
      const [running, setRunning] = useState(false)
      const [streamText, setStreamText] = useState('')
      const [unread, setUnread] = useState(() => new Set())
      const [confirmDelete, setConfirmDelete] = useState(false)
      const activeIdRef = useRef(activeId)
      const streamsRef = useRef(new Map())
      const streamTextRef = useRef('')
      const mountedRef = useRef(true)
      const scrollRef = useRef(null)
      const textareaRef = useRef(null)
      const deleteTimerRef = useRef(null)

      useEffect(() => {
        activeIdRef.current = activeId
      }, [activeId])

      useEffect(() => () => {
        mountedRef.current = false
        if (deleteTimerRef.current !== null) clearTimeout(deleteTimerRef.current)
        for (const entry of streamsRef.current.values()) entry.controller?.abort()
      }, [])

      const refreshList = useCallback(async () => {
        try {
          const payload = await apiJson(`/list?parentSessionId=${encodeURIComponent(sessionId)}`)
          if (!mountedRef.current) return
          const next = Array.isArray(payload.chats) ? payload.chats : []
          setChats(next)
          setActiveId(current => {
            if (current !== null && next.some(chat => chat.id === current)) return current
            if (typeof params.sideChatId === 'string' && next.some(chat => chat.id === params.sideChatId)) return params.sideChatId
            const stored = window.localStorage.getItem(`dsh.side-chat.active.${sessionId}`)
            if (stored !== null && next.some(chat => chat.id === stored)) return stored
            return next.length === 0 ? null : next[0].id
          })
        } catch (failure) {
          if (mountedRef.current) setError(failure?.message ?? t('panel.closed'))
        } finally {
          if (mountedRef.current) setLoading(false)
        }
      }, [sessionId, params.sideChatId, t])

      const loadDetail = useCallback(async (id) => {
        if (id === null) {
          setDetail(null)
          return
        }
        try {
          const payload = await apiJson(`/get?id=${encodeURIComponent(id)}&parentSessionId=${encodeURIComponent(sessionId)}`)
          if (!mountedRef.current) return
          setDetail(payload.chat)
          setRunning(payload.chat?.status === 'running')
          setError('')
        } catch (failure) {
          if (mountedRef.current) setError(failure?.message ?? t('panel.closed'))
        }
      }, [sessionId, t])

      useEffect(() => {
        void refreshList()
      }, [refreshList])

      useEffect(() => {
        if (typeof params.sideChatId === 'string' && params.sideChatId !== activeIdRef.current) {
          setActiveId(params.sideChatId)
        }
      }, [params.sideChatId, tab?.navigation?.revision])

      useEffect(() => {
        if (activeId === null) {
          setDetail(null)
          return
        }
        window.localStorage.setItem(`dsh.side-chat.active.${sessionId}`, activeId)
        setUnread(current => {
          if (!current.has(activeId)) return current
          const next = new Set(current)
          next.delete(activeId)
          return next
        })
        void loadDetail(activeId)
      }, [activeId, sessionId, loadDetail])

      useEffect(() => {
        if (!running || activeId === null) return
        const timer = setInterval(() => { void loadDetail(activeId) }, 1200)
        return () => clearInterval(timer)
      }, [running, activeId, loadDetail])

      useEffect(() => {
        const element = scrollRef.current
        if (element !== null) element.scrollTop = element.scrollHeight
      }, [detail?.messages?.length, streamText, activeId])

      const selectChat = (id) => {
        setActiveId(id)
        setConfirmDelete(false)
        hostCtx.sidebarRight.openTab(TAB_KIND, { params: { sideChatId: id } })
      }

      const updateChat = (next) => {
        if (next === null) return
        setChats(current => current.map(chat => chat.id === next.id
          ? { ...chat, status: next.status, title: next.title, updatedAt: next.updatedAt, error: next.error }
          : chat))
      }

      const handleEvent = (id, event) => {
        if (!mountedRef.current || event === null) return
        if (event.type === 'start') {
          setRunning(true)
          if (id === activeIdRef.current) {
            setStreamText('')
            streamTextRef.current = ''
          }
          return
        }
        if (event.type === 'delta') {
          if (id === activeIdRef.current && typeof event.text === 'string') {
            streamTextRef.current += event.text
            setStreamText(streamTextRef.current)
          }
          return
        }
        if (event.type === 'reasoning') return
        if (event.type === 'done') {
          setRunning(false)
          if (id === activeIdRef.current) {
            setStreamText('')
            streamTextRef.current = ''
            setDetail(event.chat ?? null)
            setError('')
          } else if (event.cancelled !== true) {
            setUnread(current => new Set(current).add(id))
          }
          if (event.chat !== undefined) updateChat(event.chat)
          void refreshList()
          return
        }
        if (event.type === 'error') {
          setRunning(false)
          setError(event.error?.message ?? t('panel.error'))
          if (id === activeIdRef.current && event.chat !== undefined) setDetail(event.chat)
          if (event.chat !== undefined) updateChat(event.chat)
          void refreshList()
          return
        }
        if (event.type === 'client-error') {
          setRunning(false)
          setError(event.error?.message ?? t('panel.error'))
        }
      }

      const beginStream = async (path, body) => {
        setError('')
        setNotice('')
        setRunning(true)
        setStreamText('')
        streamTextRef.current = ''
        try {
          const controller = await openStream(path, body, event => handleEvent(body.id, event))
          streamsRef.current.set(body.id, { controller })
        } catch (failure) {
          setRunning(false)
          setError(failure?.message ?? t('panel.error'))
          if (body.id === activeIdRef.current) void loadDetail(body.id)
        }
      }

      const send = () => {
        const text = draft.trim()
        if (text === '' || activeId === null || running) return
        setDraft('')
        setDetail(current => current === null ? current : {
          ...current,
          messages: [
            ...(current.messages ?? []),
            { id: `local-user-${Date.now()}`, role: 'user', content: [{ type: 'text', text }], status: 'done', createdAt: new Date().toISOString() },
            { id: `local-assistant-${Date.now()}`, role: 'assistant', content: [{ type: 'text', text: '' }], status: 'streaming', createdAt: new Date().toISOString() },
          ],
        })
        void beginStream('/turn', { id: activeId, parentSessionId: sessionId, text })
      }

      const stop = async () => {
        if (activeId === null) return
        try {
          await apiJson('/cancel', { method: 'POST', body: { id: activeId, parentSessionId: sessionId } })
        } catch (failure) {
          setError(failure?.message ?? t('panel.error'))
        }
        const entry = streamsRef.current.get(activeId)
        entry?.controller?.abort()
        streamsRef.current.delete(activeId)
        setRunning(false)
        setStreamText('')
        streamTextRef.current = ''
        setTimeout(() => { void loadDetail(activeId) }, 250)
      }

      const retry = () => {
        if (activeId === null || running) return
        setDetail(current => {
          if (current === null) return current
          const messages = [...(current.messages ?? [])]
          const last = messages[messages.length - 1]
          if (last?.role === 'assistant' && (last.status === 'error' || last.status === 'cancelled')) messages.pop()
          return { ...current, messages, status: 'running', error: null }
        })
        void beginStream('/retry', { id: activeId, parentSessionId: sessionId })
      }

      const bringBack = (text) => {
        if (typeof text !== 'string' || text.trim() === '') return
        const inserted = inputActions?.insertQuote(text, {
          label: t('quote.label'),
          title: detail?.title ?? t('tab.title'),
          detail: t('quote.detail'),
          body: text,
        }) ?? false
        setNotice(inserted ? t('panel.bringBackDone') : t('panel.error'))
        if (inserted) setTimeout(() => setNotice(''), 2500)
      }

      const deleteChat = async () => {
        if (activeId === null) return
        if (!confirmDelete) {
          setConfirmDelete(true)
          deleteTimerRef.current = setTimeout(() => setConfirmDelete(false), 3000)
          return
        }
        setConfirmDelete(false)
        try {
          await apiJson('/delete', { method: 'POST', body: { id: activeId, parentSessionId: sessionId } })
          const removed = activeId
          setDetail(null)
          setActiveId(null)
          setChats(current => current.filter(chat => chat.id !== removed))
          await refreshList()
        } catch (failure) {
          setError(failure?.message ?? t('panel.error'))
        }
      }

      const activeSummary = chats.find(chat => chat.id === activeId)
      const current = detail?.id === activeId ? detail : null
      const messages = Array.isArray(current?.messages) ? current.messages : []
      const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant')
      const canRetry = lastAssistant !== undefined && (lastAssistant.status === 'error' || lastAssistant.status === 'cancelled')
      const showingStream = running && activeId !== null

      return h('div', { className: 'dsc-panel' },
        h('div', { className: 'dsc-head' },
          h('span', { className: 'dsc-dot', 'data-running': running ? '' : undefined, 'data-error': current?.status === 'error' ? '' : undefined }),
          h('span', { className: 'dsc-title', title: activeSummary?.title ?? t('tab.title') }, t('tab.title')),
          chats.length > 1 ? h('select', {
            className: 'dsc-select',
            value: activeId ?? '',
            'aria-label': t('panel.select'),
            onChange: event => selectChat(event.target.value),
          }, chats.map(chat => h('option', { key: chat.id, value: chat.id },
            `${unread.has(chat.id) ? '• ' : ''}${chat.title}`))) : null,
          h('button', {
            type: 'button',
            className: 'dsc-iconButton',
            title: t('panel.close'),
            'aria-label': t('panel.close'),
            onClick: () => tab?.actions?.close?.(),
          }, '×'),
        ),
        h('div', { className: 'dsc-scroll', ref: scrollRef },
          activeId === null
            ? h('div', { className: 'dsc-empty' },
              h('div', null, t('panel.empty')),
              h('div', null, t('panel.emptyHint')))
            : null,
          current === null ? null : h(React.Fragment, null,
            h('div', { className: 'dsc-quote' },
              h('div', { className: 'dsc-quoteText' }, current.quoteRef?.exact ?? ''),
              h('div', { className: 'dsc-meta' },
                h('div', null, `${t('panel.quote')} · ${t('panel.parent')}: ${current.parentTitle ?? '—'} · ${t('panel.anchor')}: ${(current.anchorMessageId || '—').slice(0, 12)}`),
                h('div', null, `${t('panel.snapshot')}: ${t('panel.snapshotMeta').replace('{count}', String(current.contextSnapshot?.messageCount ?? 0)).replace('{tokens}', String(current.contextSnapshot?.estimatedTokens ?? 0))}`),
                current.contextSnapshot?.truncatedCount > 0
                  ? h('div', null, t('panel.truncated').replace('{count}', String(current.contextSnapshot.truncatedCount)))
                  : null)),
            messages.map(message => h('div', { key: message.id, className: 'dsc-message', 'data-role': message.role },
              h('div', { className: 'dsc-role' }, message.role === 'assistant' ? t('panel.assistant') : t('panel.you')),
              h('div', { className: 'dsc-body' }, message.role === 'assistant'
                ? (message.content?.[0]?.text ?? '')
                : (message.content?.[0]?.text ?? '')),
              message.role === 'assistant' && (message.content?.[0]?.text ?? '') !== ''
                ? h('div', { className: 'dsc-messageActions' },
                  h('button', {
                    type: 'button', className: 'dsc-mini',
                    onClick: () => bringBack(message.content?.[0]?.text ?? ''),
                  }, t('panel.backToMain')))
                : null)),
            showingStream
              ? h('div', { className: 'dsc-message', 'data-role': 'assistant' },
                h('div', { className: 'dsc-role' }, t('panel.assistant')),
                h('div', { className: 'dsc-streaming' }, h('span', { className: 'dsc-dot', 'data-running': '' }), t('panel.running')),
                streamText === '' ? null : h('div', { className: 'dsc-body' }, streamText))
              : null,
            canRetry && !running && error === ''
              ? h('div', { className: 'dsc-messageActions' },
                h('button', { type: 'button', className: 'dsc-mini', onClick: retry }, t('panel.retry')))
              : null,
            error !== ''
              ? h('div', { className: 'dsc-error', role: 'alert' },
                h('span', null, error),
                canRetry ? h('button', { type: 'button', className: 'dsc-mini', onClick: retry }, t('panel.retry')) : null)
              : null,
            notice !== '' ? h('div', { className: 'dsc-note', role: 'status' }, notice) : null,
          ),
        ),
        h('div', { className: 'dsc-foot' },
          h('textarea', {
            ref: textareaRef,
            className: 'dsc-input',
            value: draft,
            placeholder: t('panel.placeholder'),
            'aria-label': t('panel.placeholder'),
            disabled: activeId === null || running,
            onChange: event => setDraft(event.target.value),
            onKeyDown: event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                event.preventDefault()
                send()
              }
            },
          }),
          h('div', { className: 'dsc-footRow' },
            chats.length > 1 ? h('button', {
              type: 'button',
              className: 'dsc-mini',
              onClick: () => { void deleteChat() },
            }, confirmDelete ? t('panel.confirmDelete') : t('panel.delete')) : null,
            h('span', { className: 'dsc-note', style: { marginRight: 'auto' } },
              current === null ? '' : statusLabel(current.status, t)),
            running
              ? h('button', { type: 'button', className: 'dsc-action', 'data-secondary': '', onClick: () => { void stop() } }, t('panel.stop'))
              : h('button', {
                type: 'button',
                className: 'dsc-action',
                disabled: activeId === null || draft.trim() === '',
                onClick: send,
              }, t('panel.send')),
          ),
        ),
      )
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'side-chat: zh copy')
      ctx.effect(() => ctx.locale.register(NS, 'en', en), 'side-chat: en copy')
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-side-chat-plugin'
        tag.dataset.pluginCss = 'dsh-side-chat-plugin/style.css'
        tag.textContent = css
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'side-chat: styles')

      // The selection bridge lives in the composer dock because that slot is
      // session-scoped and already carries `inputActions` for the parent
      // conversation. It renders through a portal so it can sit at the
      // selection without changing the composer layout.
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'side-chat-selection',
        locale: NS,
      }, props => h(SelectionBridge, { ...props, hostCtx: ctx })))

      const boundPanel = props => h(SideChatPanel, { ...props, hostCtx: ctx })
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        keepMounted: true,
        title: () => t('tab.title'),
        guide: [{
          id: 'side-chats',
          title: () => t('guide.title'),
          description: () => t('guide.description'),
          order: 20,
        }],
      }), 'side-chat: sidebar tab type')
      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        locale: NS,
      }, boundPanel))
    }

    exports.name = 'side-chat'
    exports.inject = ['slots', 'locale', 'sessions', 'uiConversation', 'sidebarRight', 'sidebarRightTabs']
    exports.apply = apply
    return module.exports
  },
})
