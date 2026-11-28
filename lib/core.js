/**
 * Pure helpers for side-chat forks and resource addresses.
 *
 * A side chat is a real, ephemeral fork of the parent Session. This module
 * keeps only deterministic helpers: anchor resolution on the parent surface,
 * quote-message text, and the `dsh-resource://sidechat/...` address.
 */

/** URL prefix for one side-chat Session resource. */
export const SIDECHAT_ADDRESS_PREFIX = 'dsh-resource://sidechat/session/'

/** Collapse whitespace for selection matching. */
export function normalizeText(text) {
  return String(text ?? '').replace(/\r\n?/gu, '\n').replace(/\s+/gu, ' ').trim()
}

/** Join text content blocks. */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text'
      && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/** Map a derived message to the surface event seq that produced it. */
export function messageSequences(session) {
  const result = new Map()
  const surface = session?.surface
  if (surface === null || surface === undefined || !Array.isArray(surface.nodes)
    || typeof session.eventAt !== 'function') return result
  for (const seq of surface.nodes) {
    const event = session.eventAt(seq)
    if (event === null || event === undefined) continue
    const message = event.type === 'user/message'
      ? event.data
      : event.type === 'assistant/message'
        ? event.data?.message
        : undefined
    if (message !== null && message !== undefined && message.id !== undefined) {
      result.set(String(message.id), Number(seq))
    }
  }
  return result
}

/** Project parent messages into plain text rows with their surface seq. */
export function parentMessages(session) {
  if (session === null || session === undefined || typeof session.deriveMessages !== 'function') return []
  const seqById = messageSequences(session)
  const rows = []
  for (const message of session.deriveMessages()) {
    const role = message?.role === 'assistant' ? 'assistant' : message?.role === 'user' ? 'user' : undefined
    if (role === undefined) continue
    const text = textOfContent(message.content)
    if (text.trim() === '') continue
    rows.push({ id: String(message.id), role, text, seq: seqById.get(String(message.id)) ?? null })
  }
  return rows
}

/** Find the message a quote came from. */
export function locateAnchor(messages, quote = {}) {
  if (messages.length === 0) return { index: -1, message: null, match: 'none' }
  const exact = normalizeText(quote.exact)
  const wantedId = quote.messageId === undefined || quote.messageId === null ? '' : String(quote.messageId)
  if (wantedId !== '') {
    const byId = messages.findIndex(message => String(message.id) === wantedId)
    if (byId >= 0) return { index: byId, message: messages[byId], match: 'id' }
  }
  if (exact !== '') {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (normalizeText(messages[index].text).includes(exact)) {
        return { index, message: messages[index], match: 'exact' }
      }
    }
    const prefix = normalizeText(quote.prefix)
    const suffix = normalizeText(quote.suffix)
    if (prefix !== '' || suffix !== '') {
      for (let index = messages.length - 1; index >= 0; index--) {
        const text = normalizeText(messages[index].text)
        if ((prefix === '' || text.includes(prefix)) && (suffix === '' || text.includes(suffix))) {
          return { index, message: messages[index], match: 'affix' }
        }
      }
    }
    const fragment = exact.slice(0, Math.min(24, exact.length))
    if (fragment.length >= 4) {
      for (let index = messages.length - 1; index >= 0; index--) {
        if (normalizeText(messages[index].text).includes(fragment)) {
          return { index, message: messages[index], match: 'fragment' }
        }
      }
    }
  }
  return { index: messages.length - 1, message: messages[messages.length - 1], match: 'none' }
}

/** Extract a message-id-shaped UUID from a rendered chat node key, if present. */
export function messageIdFromBlock(blockId) {
  const match = String(blockId ?? '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu)
  return match?.[0]
}

/**
 * Resolve the inclusive surface seq this side chat forks through.
 * The selected message wins; otherwise the newest surface node is used so the
 * side chat still opens with a usable parent prefix.
 */
export function resolveAnchor(session, quote, anchorMessageId) {
  const rows = parentMessages(session)
  const located = locateAnchor(rows, { ...quote, messageId: anchorMessageId ?? quote?.messageId })
  const message = located.message
  if (message !== null && Number.isSafeInteger(message.seq) && message.seq >= 0) {
    return { boundary: message.seq, anchorMessageId: message.id, match: located.match }
  }
  const nodes = session?.surface?.nodes
  if (Array.isArray(nodes) && nodes.length > 0) {
    const last = Number(nodes[nodes.length - 1])
    if (Number.isSafeInteger(last) && last >= 0) {
      return { boundary: last, anchorMessageId: message?.id ?? '', match: 'none' }
    }
  }
  return { boundary: -1, anchorMessageId: message?.id ?? '', match: 'none' }
}

/** First user line used as a human-readable parent label. */
export function deriveParentTitle(rows) {
  const firstUser = rows.find(row => row.role === 'user' && row.text.trim() !== '')
  if (firstUser === undefined) return '当前对话'
  const line = firstUser.text.replace(/\s+/gu, ' ').trim()
  return line.length > 42 ? `${line.slice(0, 41)}…` : line
}

/** Short side-chat title derived from the selected excerpt. */
export function titleFromQuote(quote, parentTitle = '当前对话') {
  const exact = normalizeText(quote?.exact)
  if (exact === '') return `侧聊 · ${parentTitle}`
  return `侧聊 · ${exact.length > 26 ? `${exact.slice(0, 25)}…` : exact}`
}

/** The visible and model-visible boundary message injected into the fork. */
export function quoteMessage({ parentTitle, anchorMessageId, exact, prefix, suffix }) {
  const source = anchorMessageId === undefined || anchorMessageId === '' ? '父对话末尾' : anchorMessageId
  const context = prefix !== undefined || suffix !== undefined
    ? `\n\n上下文：…${prefix ?? ''}【选中片段】${suffix ?? ''}…`
    : ''
  return [
    '以下是本次侧边对话的引用来源。',
    '',
    `父对话：${parentTitle}`,
    `锚点消息：${source}`,
    '',
    '选中原文：',
    '"""',
    exact,
    '"""',
    context,
    '',
    '请围绕这段引用，回答用户接下来在侧边对话中提出的问题。',
  ].join('\n')
}

/** Compose one canonical resource address for a side-chat Session. */
export function sideChatAddress({ childSessionId, parentSessionId, title }) {
  const query = new URLSearchParams({
    parent: String(parentSessionId),
    title: String(title ?? ''),
  })
  return `${SIDECHAT_ADDRESS_PREFIX}${encodeURIComponent(String(childSessionId))}?${query.toString()}`
}

/** Parse a canonical side-chat resource address. */
export function parseSideChatAddress(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== 'sidechat') return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2 || parts[0] !== 'session') return undefined
  const parent = url.searchParams.get('parent')
  if (parent === null || parent === '') return undefined
  try {
    const childSessionId = decodeURIComponent(parts[1])
    if (childSessionId === '') return undefined
    return {
      childSessionId,
      parentSessionId: parent,
      title: url.searchParams.get('title') ?? '',
    }
  } catch {
    return undefined
  }
}
