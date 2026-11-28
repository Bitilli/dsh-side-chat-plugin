/**
 * Browser half of the Side chat plugin.
 *
 * The side chat is a native embedded Conversation for an ephemeral forked
 * Session. This module only contributes:
 *  - the compact selection bar (continue in main / ask in side, or quote in a
 *    side Conversation);
 *  - the `sidechat` resource provider that binds a child Session to the tab;
 *  - the sidebar tab type that hosts the native Conversation.
 */
window.__ModuleLoader__.load({
  id: 'dsh-side-chat-plugin',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createPortal } = require('react-dom')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React

    const NS = 'sideChat'
    const API = '/api/side-chat'
    const KIND = 'sidechat'
    const TAB_ID = 'dsh-side-chat-plugin'
    const ADDRESS_PREFIX = 'dsh-resource://sidechat/session/'
    const purgingParents = new Set()

    const zh = {
      'tab.title': '侧边对话',
      'guide.title': '侧边对话',
      'guide.description': '在侧边与主对话同权限地追问，关闭即清除',
      'bar.continue': '在主对话继续问',
      'bar.side': '在侧边问',
      'bar.sideQuote': '引用并追问',
      'bar.close': '关闭操作栏',
      'bar.busy': '正在创建侧边对话…',
      'bar.failed': '操作失败，请重试。',
      'quote.label': '引用',
      'quote.detail': '选中片段',
      'quote.source': '引用自当前对话',
      'quote.current': '当前对话',
    }

    const en = {
      'tab.title': 'Side chat',
      'guide.title': 'Side chats',
      'guide.description': 'Ask with the main chat permissions; closing clears it',
      'bar.continue': 'Continue in main',
      'bar.side': 'Ask in side',
      'bar.sideQuote': 'Quote and ask',
      'bar.close': 'Dismiss actions',
      'bar.busy': 'Creating side chat…',
      'bar.failed': 'Action failed. Try again.',
      'quote.label': 'Quote',
      'quote.detail': 'Selected excerpt',
      'quote.source': 'Quoted from this conversation',
      'quote.current': 'This conversation',
    }

    const css = `
      .dsc-bar{position:fixed;z-index:80;display:flex;flex-direction:column;gap:6px;align-items:stretch;
        min-width:240px;max-width:min(360px,calc(100vw - 16px));padding:5px;border-radius:12px;
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

      .dsc-native{display:flex;flex-direction:column;height:100%;min-height:0}
    `

    function parseAddress(value) {
      let url
      try {
        url = new URL(value)
      } catch {
        return undefined
      }
      if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== 'sidechat') return undefined
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts.length !== 2 || parts[0] !== 'session') return undefined
      const parentSessionId = url.searchParams.get('parent')
      if (parentSessionId === null || parentSessionId === '') return undefined
      try {
        const childSessionId = decodeURIComponent(parts[1])
        if (childSessionId === '') return undefined
        return {
          childSessionId,
          parentSessionId,
          title: url.searchParams.get('title') ?? '',
        }
      } catch {
        return undefined
      }
    }

    function addressOf(childSessionId, parentSessionId, title) {
      const query = new URLSearchParams({ parent: parentSessionId, title: title ?? '' })
      return `${ADDRESS_PREFIX}${encodeURIComponent(childSessionId)}?${query.toString()}`
    }

    async function apiJson(path, { method = 'GET', body } = {}) {
      const response = await fetch(`${API}${path}`, {
        method,
        credentials: 'same-origin',
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
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

    function elementOf(node) {
      return node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement ?? null
    }

    function insideBar(node) {
      return node instanceof Element && node.closest('[data-dsh-side-bar]') !== null
    }

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

    /** Selection bar for the main or an embedded side Conversation. */
    function SelectionBridge({ hostCtx, sessionId, inputActions, t }) {
      const [bar, setBar] = useState(null)
      const [busy, setBusy] = useState(false)
      const [failure, setFailure] = useState('')
      const barRef = useRef(null)
      const markerRef = useRef(null)
      const firstButtonRef = useRef(null)
      const keyboardRef = useRef(false)
      const frameRef = useRef(0)
      const infoRef = useRef(null)
      const sideRef = useRef(false)

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
        sideRef.current = markerRef.current?.closest('[data-side-chat-session]') !== null
        const placement = barPlacement(info.rect)
        setBar({ ...info, ...placement, inSide: sideRef.current })
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

      const clearSelection = () => {
        document.getSelection()?.removeAllRanges()
      }

      const insertQuote = () => {
        const info = infoRef.current
        if (info === null || busy) return
        const summary = {
          label: t('quote.label'),
          title: sideRef.current ? t('tab.title') : t('quote.current'),
          detail: t('quote.detail'),
          body: info.text,
        }
        if (!(inputActions?.insertQuote(info.text, summary) ?? false)) {
          setFailure(t('bar.failed'))
          return
        }
        clearSelection()
        close()
      }

      const actMain = () => {
        const info = infoRef.current
        if (info === null || busy) return
        const sent = `${info.text}\n\n${t('quote.source')}`
        const summary = {
          label: t('quote.label'),
          title: t('quote.current'),
          detail: t('quote.detail'),
          body: sent,
        }
        if (!(inputActions?.insertQuote(sent, summary) ?? false)) {
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
          if (typeof result.sessionId !== 'string') throw new Error('missing side-chat session id')
          const address = result.address ?? addressOf(result.sessionId, sessionId, result.title)
          hostCtx.sidebarRight.openResource(address)
          clearSelection()
          close()
        } catch (error) {
          setFailure(error?.message ?? t('bar.failed'))
          setBusy(false)
        }
      }

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
            if (sideRef.current) insertQuote()
            else actMain()
          } else if (event.key.toLowerCase() === 's' && !sideRef.current) {
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

      const marker = h('span', {
        ref: markerRef,
        hidden: true,
        'data-dsh-side-bridge': '',
        'aria-hidden': 'true',
      })
      if (bar === null) return marker
      return h(React.Fragment, null,
        marker,
        createPortal(
          h('div', {
            ref: barRef,
            className: 'dsc-bar',
            role: 'toolbar',
            'aria-label': bar.inSide ? t('bar.sideQuote') : t('bar.continue'),
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
                onClick: bar.inSide ? insertQuote : actMain,
              }, bar.inSide ? `❝ ${t('bar.sideQuote')}` : `↩ ${t('bar.continue')}`),
              bar.inSide ? null : h('button', {
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
            h('div', { className: 'dsc-barHint' }, bar.inSide ? 'Alt+Q · Esc' : 'Alt+Q / Alt+S · Esc'),
          ),
          document.body,
        ),
      )
    }

    /** Native Conversation body for one side-chat Session resource. */
    function SideChatTab({ hostCtx, sessionId, useTabInfo, useResource, SessionProvider, renderSlot, renderFactorySlot, t }) {
      const { tab, sidebar } = useTabInfo()
      const parsed = parseAddress(tab.contentId)
      const resource = useResource(tab.contentId)
      const purged = useRef(false)
      const wasExpanded = useRef(sidebar.expanded)
      const parentId = parsed?.parentSessionId ?? sessionId

      useEffect(() => {
        if (wasExpanded.current && !sidebar.expanded && !purged.current) {
          purged.current = true
          void purgeParent(hostCtx, parentId)
        }
        wasExpanded.current = sidebar.expanded
      }, [hostCtx, parentId, sidebar.expanded])

      useEffect(() => {
        if (resource.status !== 'failed' || tab.actions?.close === undefined) return
        // A tab restored after the Host purged its ephemeral Session has no
        // resource; close the dead tab instead of showing an empty pane.
        const timer = setTimeout(() => { tab.actions.close() }, 100)
        return () => clearTimeout(timer)
      }, [resource.status, tab])

      if (resource.value === undefined) {
        return h('div', { className: 'dsc-native', 'data-side-chat-session': parsed?.childSessionId ?? '' })
      }
      return h('div', {
        className: 'dsc-native',
        'data-side-chat-session': parsed?.childSessionId ?? resource.value.childSessionId,
      },
        h(SessionProvider, { session: resource.value.reference },
          h(NativeConversation, { renderFactorySlot, renderSlot })),
      )
    }

    /** Render the shared Conversation under the child SessionProvider. */
    function NativeConversation({ renderFactorySlot, renderSlot }) {
      if (renderFactorySlot !== undefined) {
        return renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }, {
          slots: { views: FixedChatConversationView },
        })
      }
      return renderSlot('sidebar.chat.conversation', {})
    }

    /** Fixed Chat selection used by the embedded Conversation occurrence. */
    function FixedChatConversationView(props) {
      return h(React.Fragment, null, props.renderSlot('conversation.session', { view: 'chat' }))
    }

    async function purgeParent(hostCtx, parentSessionId) {
      if (purgingParents.has(parentSessionId)) return
      purgingParents.add(parentSessionId)
      try {
        await apiJson('/purge', { method: 'POST', body: { parentSessionId } })
        const tabs = hostCtx.sidebarRight.openTabs.getSnapshot()
          .filter(tab => tab.kind === KIND && tab.sessionId === parentSessionId)
        for (const tab of tabs) {
          try {
            hostCtx.sidebarRight.close(tab.tabId)
          } catch {
            // The tab may already be closing.
          }
        }
      } catch (error) {
        console.error('[side-chat] purge failed', error)
      } finally {
        setTimeout(() => purgingParents.delete(parentSessionId), 500)
      }
    }

    function waitForAbort(signal) {
      if (signal.aborted) return Promise.resolve()
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }

    function sideChatResource(sessions) {
      return {
        protocol: 'sidechat',
        async *open(resourceAddress, { signal }) {
          const parsed = parseAddress(resourceAddress)
          if (parsed === undefined) throw new Error(`side-chat: invalid address "${resourceAddress}"`)
          if (signal.aborted) return
          const reference = sessions.retain(parsed.childSessionId, { source: 'sidebarChat', signal })
          try {
            yield {
              ok: true,
              value: {
                childSessionId: parsed.childSessionId,
                parentSessionId: parsed.parentSessionId,
                title: parsed.title,
                reference,
              },
            }
            await waitForAbort(signal)
          } finally {
            reference.release()
          }
        },
      }
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

      // Keep the main-composer selection bar for both the main chat and an
      // embedded side Conversation; the side variant only quotes into the side
      // composer and never nests another side chat.
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'side-chat-selection',
        locale: NS,
      }, props => h(SelectionBridge, { ...props, hostCtx: ctx })))

      ctx.effect(() => ctx.resources.register(sideChatResource(ctx.sessions)), 'side-chat: resource provider')

      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: KIND,
        patterns: [`${ADDRESS_PREFIX}**`],
        priority: 'extension',
        keepMounted: true,
        canOpen: address => parseAddress(address) !== undefined,
        title: address => {
          const parsed = parseAddress(address)
          return parsed !== undefined && parsed.title !== '' ? parsed.title : t('tab.title')
        },
      }), 'side-chat: sidebar tab type')

      ctx.effect(() => ctx.sidebarRight.registerCloseHandler(KIND, (parentSessionId, tab) => {
        if (purgingParents.has(parentSessionId)) return
        const siblings = ctx.sidebarRight.openTabs.getSnapshot()
          .filter(candidate => candidate.kind === KIND && candidate.sessionId === parentSessionId)
        if (siblings.length <= 1) {
          void purgeParent(ctx, parentSessionId)
          return
        }
        const parsed = parseAddress(tab.contentId)
        if (parsed === undefined) return
        void apiJson('/delete', {
          method: 'POST',
          body: { sessionId: parsed.childSessionId, parentSessionId },
        }).catch(error => console.error('[side-chat] delete failed', error))
      }), 'side-chat: close handler')

      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        locale: NS,
        children: { 'sidebar.chat.conversation': { kind: 'single', scope: 'session' } },
      }, props => h(SideChatTab, { ...props, hostCtx: ctx })))
    }

    exports.name = 'side-chat'
    exports.inject = ['slots', 'locale', 'sessions', 'sidebarRight', 'sidebarRightTabs', 'resources']
    exports.apply = apply
    return module.exports
  },
})
