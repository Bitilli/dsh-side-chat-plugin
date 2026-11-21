/**
 * Pure context and message helpers for side chats.
 *
 * Nothing here touches Cordis, the filesystem, or the network. Keeping the
 * anchoring and budgeting rules pure makes them testable with plain objects and
 * keeps the Host service focused on orchestration.
 */

/** Upper bound for one user turn, matching the route's body ceiling. */
export const MAX_TURN_TEXT = 20_000

/** Default token budget for the frozen parent snapshot. */
export const DEFAULT_SNAPSHOT_TOKENS = 8_000

/** One normalized message copied out of a parent Session. */
export function normalizeRole(role) {
  return role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : undefined
}

/** Join the text blocks of a model-visible content array. */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text'
      && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/** Collapse whitespace for matching selections whose rendered text differs. */
export function normalizeText(text) {
  return String(text ?? '').replace(/\r\n?/gu, '\n').replace(/\s+/gu, ' ').trim()
}

/**
 * Project a parent Session's derived messages into plain text rows.
 * @param {object} session - live Session with `deriveMessages()` and `surface`.
 * @returns {Array<{ id: string, role: 'user' | 'assistant', text: string, seq: number | null }>}
 */
export function parentMessages(session) {
  if (session === null || session === undefined || typeof session.deriveMessages !== 'function') return []
  const seqById = messageSequences(session)
  const rows = []
  for (const message of session.deriveMessages()) {
    const role = normalizeRole(message?.role)
    if (role === undefined) continue
    const text = textOfContent(message.content)
    if (text.trim() === '') continue
    rows.push({ id: String(message.id), role, text, seq: seqById.get(String(message.id)) ?? null })
  }
  return rows
}

/** Map derived message identity to the surface node seq that produced it. */
function messageSequences(session) {
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

/**
 * Find the message an excerpt came from.
 *
 * Order of attempts: the explicit id, then exact text, then prefix+suffix
 * corroboration, then the newest matching fragment. The explicit id is a hint,
 * not a requirement, because messages can be edited, deleted, or replaced.
 * @param {Array<{ id: string, role: string, text: string }>} messages - parent rows.
 * @param {{ messageId?: string, exact?: string, prefix?: string, suffix?: string }} quote - quote data.
 * @returns {{ index: number, message: object | null, match: 'id' | 'exact' | 'affix' | 'fragment' | 'none' }}
 */
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
  // The newest message is the safest fallback: it preserves a usable snapshot
  // instead of failing the side chat when the anchor was edited away.
  return { index: messages.length - 1, message: messages[messages.length - 1], match: 'none' }
}

/** Default heuristic used when no `tokenMeter` is available. */
export function heuristicTokens(text) {
  return Math.max(1, Math.ceil(String(text ?? '').length / 4))
}

/**
 * Freeze the prefix of the parent transcript up to and including the anchor.
 *
 * The newest rows win the budget; the anchor row is always retained. The
 * returned `strategy` and counts are persisted for debugging the request that
 * the model actually received.
 * @param {Array<{ id: string, role: string, text: string, seq?: number | null }>} rows - parent rows.
 * @param {number} anchorIndex - inclusive row index, or -1 for an empty snapshot.
 * @param {{ maxTokens?: number, estimate?: (row: object) => number }} options - budget controls.
 */
export function freezeSnapshot(rows, anchorIndex, options = {}) {
  const maxTokens = Number.isFinite(options.maxTokens) && options.maxTokens > 0
    ? Math.floor(options.maxTokens)
    : DEFAULT_SNAPSHOT_TOKENS
  const estimate = typeof options.estimate === 'function' ? options.estimate : row => heuristicTokens(row.text)
  const eligible = anchorIndex < 0 ? [] : rows.slice(0, anchorIndex + 1)
  if (eligible.length === 0) {
    return {
      messages: [], truncatedCount: 0, excludedAfterAnchor: rows.length, totalMessages: rows.length,
      estimatedTokens: 0, strategy: 'tail-budget', maxTokens,
    }
  }
  const kept = []
  let used = 0
  for (let index = eligible.length - 1; index >= 0; index--) {
    const row = eligible[index]
    const cost = Math.max(1, Math.floor(estimate(row)))
    const anchor = index === eligible.length - 1
    if (!anchor && used + cost > maxTokens) break
    kept.unshift({ ...row, tokens: cost })
    used += cost
    if (used >= maxTokens && !anchor) break
  }
  const firstKept = eligible.length - kept.length
  return {
    messages: kept.map(row => ({ id: row.id, role: row.role, text: row.text, seq: row.seq ?? null })),
    truncatedCount: firstKept,
    excludedAfterAnchor: rows.length - eligible.length,
    totalMessages: rows.length,
    estimatedTokens: used,
    strategy: 'tail-budget',
    maxTokens,
  }
}

/** First nonblank line of a conversation's opening user message. */
export function deriveParentTitle(rows) {
  const firstUser = rows.find(row => row.role === 'user' && row.text.trim() !== '')
  if (firstUser === undefined) return '当前对话'
  const line = firstUser.text.replace(/\s+/gu, ' ').trim()
  return line.length > 42 ? `${line.slice(0, 41)}…` : line
}

/** Short title for a side chat, derived from the selected excerpt. */
export function deriveSideChatTitle(quote, parentTitle) {
  const exact = normalizeText(quote?.exact)
  if (exact === '') return parentTitle === '' ? '侧边对话' : `${parentTitle} · 侧边`
  const excerpt = exact.length > 28 ? `${exact.slice(0, 27)}…` : exact
  return excerpt
}

/**
 * Build the system prompt: permanent side-chat rules plus the frozen snapshot.
 * The snapshot is never re-read from the parent, so later parent turns cannot
 * leak into this side chat.
 * @param {object} chat - stored side-chat record.
 */
export function buildSystemPrompt(chat) {
  const snapshot = chat.contextSnapshot
  const lines = [
    'You are a side-chat assistant inside DeepSeek Harness.',
    'This side chat is independent of its parent conversation. The parent transcript below is a read-only snapshot captured when the side chat was created; later parent messages are not included, and nothing you answer is written back to the parent.',
    'Answer the user\'s current question directly. Do not claim tools, file access, or actions that you cannot perform in this conversation.',
    '',
    `Parent conversation: ${chat.parentTitle} (${chat.parentSessionId})`,
    `Snapshot: ${snapshot.messages.length} messages, captured ${snapshot.capturedAt}, ~${snapshot.estimatedTokens} tokens, ${snapshot.truncatedCount} earlier messages omitted (${snapshot.strategy}).`,
    `Anchor message: ${chat.anchorMessageId || '未定位，使用父对话末尾'}${chat.anchorSeq === null || chat.anchorSeq === undefined ? '' : ` at seq ${chat.anchorSeq}`}`,
    '',
    '--- parent snapshot (read-only) ---',
  ]
  if (snapshot.messages.length === 0) {
    lines.push('(empty)')
  } else {
    for (const message of snapshot.messages) {
      lines.push(`${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.text}`)
    }
  }
  lines.push('--- end parent snapshot ---', '', '--- selected excerpt ---')
  lines.push(chat.quoteRef.exact)
  lines.push('--- end selected excerpt ---')
  return lines.join('\n')
}

/** Turn the plain rows back into provider request messages. */
export function buildRequestMessages(chat, selection) {
  const provider = selection?.provider ?? 'unknown'
  const model = selection?.model ?? 'unknown'
  const messages = []
  for (const message of chat.messages) {
    const text = textOfContent(message.content)
    if (text.trim() === '') continue
    if (message.role === 'user') {
      messages.push({ role: 'user', content: [{ type: 'text', text }] })
      continue
    }
    if (message.role === 'assistant') {
      if (message.status === 'error') continue
      messages.push({
        id: message.id,
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider, model },
      })
    }
  }
  return messages
}

/** Compact list projection: identity, status and timestamps, never the transcript. */
export function publicChatSummary(chat) {
  return {
    id: chat.id,
    kind: chat.kind,
    parentSessionId: chat.parentSessionId,
    parentTitle: chat.parentTitle,
    anchorMessageId: chat.anchorMessageId,
    anchorSeq: chat.anchorSeq,
    contextSnapshotId: chat.contextSnapshotId,
    title: chat.title,
    status: chat.status,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    error: chat.error ?? null,
  }
}

/** Render the SSE payload for a stored chat, without stream-only fields. */
export function publicChat(chat) {
  return {
    id: chat.id,
    kind: chat.kind,
    parentSessionId: chat.parentSessionId,
    parentTitle: chat.parentTitle,
    anchorMessageId: chat.anchorMessageId,
    anchorSeq: chat.anchorSeq,
    contextSnapshotId: chat.contextSnapshotId,
    title: chat.title,
    status: chat.status,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    error: chat.error ?? null,
    quoteRef: chat.quoteRef,
    contextSnapshot: chat.contextSnapshot,
    messages: chat.messages,
  }
}
