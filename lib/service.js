/**
 * Host-side side-chat orchestration.
 *
 * A side chat persists outside the Session log, freezes a snapshot of the
 * parent at the anchor message, and runs ordinary model calls with its own
 * message list. The parent Session is read once at creation and never mutated.
 */
import { randomUUID } from 'node:crypto'
import {
  MAX_TURN_TEXT, buildRequestMessages, buildSystemPrompt, deriveParentTitle,
  deriveSideChatTitle, freezeSnapshot, heuristicTokens, locateAnchor, normalizeText,
  parentMessages, publicChat, publicChatSummary, textOfContent,
} from './core.js'

/** Error with an HTTP status and a stable code. */
export class SideChatError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'SideChatError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function iso(now) {
  return new Date(now).toISOString()
}

function shortId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`
}

/** Orchestrates side-chat records and their model turns. */
export class SideChatService {
  /**
   * @param {object} options - injected dependencies.
   * @param {import('./store.js').SideChatStore} options.store - durable store.
   * @param {(id: string) => object | undefined} options.getSession - live Session lookup.
   * @param {(options: object) => AsyncIterable<object>} options.stream - model stream.
   * @param {() => { provider: string, model: string, reasoningEffort?: string } | undefined} options.selection - model route.
   * @param {() => number} [options.now] - clock.
   * @param {(row: object) => number} [options.estimate] - token estimator.
   * @param {number} [options.maxSnapshotTokens] - default snapshot budget.
   */
  constructor({ store, getSession, stream, selection, now = () => Date.now(), estimate, maxSnapshotTokens = 8_000 }) {
    this.store = store
    this.getSession = getSession
    this.stream = stream
    this.selection = selection
    this.now = now
    this.estimate = typeof estimate === 'function' ? estimate : row => heuristicTokens(row.text)
    this.maxSnapshotTokens = maxSnapshotTokens
    this.streams = new Map()
  }

  async ready() {
    await this.store.load()
    await this.#recoverInterrupted()
    return this
  }

  /** Normalize records whose stream died with the Host process. */
  async #recoverInterrupted() {
    for (const chat of this.store.list()) {
      let changed = false
      if (chat.status === 'running') {
        chat.status = 'error'
        chat.error = 'Host restarted while the side chat was running.'
        changed = true
      }
      for (const message of chat.messages ?? []) {
        if (message.status === 'streaming') {
          message.status = 'error'
          message.error = 'Host restarted while this answer was streaming.'
          changed = true
        }
      }
      if (changed) await this.store.put(chat)
    }
  }

  #session(parentSessionId) {
    const session = this.getSession(parentSessionId)
    if (session === undefined || session === null) {
      throw new SideChatError(404, 'parent-not-found', '父对话不存在或尚未加载。', { parentSessionId })
    }
    return session
  }

  #owned(id, parentSessionId) {
    const chat = this.store.get(id)
    if (chat === undefined) throw new SideChatError(404, 'side-chat-not-found', '侧边对话不存在。', { id })
    if (parentSessionId !== undefined && chat.parentSessionId !== parentSessionId) {
      throw new SideChatError(404, 'side-chat-not-found', '侧边对话不属于该父对话。', { id })
    }
    return chat
  }

  /**
   * Create a side chat and freeze the parent prefix at the anchor.
   * @param {object} input - create request.
   * @param {string} input.parentSessionId - live parent Session.
   * @param {object} input.quote - selected excerpt (`exact` required).
   * @param {string} [input.anchorMessageId] - caller hint for the anchor.
   * @param {string} [input.title] - optional title override.
   * @param {{ maxTokens?: number }} [input.contextPolicy] - snapshot budget.
   */
  async create({ parentSessionId, quote, anchorMessageId, title, contextPolicy } = {}) {
    await this.ready()
    if (typeof parentSessionId !== 'string' || parentSessionId === '') {
      throw new SideChatError(400, 'invalid-parent', '缺少 parentSessionId。')
    }
    const exact = typeof quote?.exact === 'string' ? quote.exact : ''
    if (normalizeText(exact).length < 1) {
      throw new SideChatError(400, 'empty-quote', '引用原文不能为空。')
    }
    if (exact.length > MAX_TURN_TEXT) {
      throw new SideChatError(400, 'quote-too-large', '引用原文过长。')
    }
    const session = this.#session(parentSessionId)
    const rows = parentMessages(session)
    const located = locateAnchor(rows, { ...quote, messageId: anchorMessageId ?? quote?.messageId })
    const anchorRow = located.message
    const anchorIndex = located.index
    const requestedTokens = Number(contextPolicy?.maxTokens)
    const maxTokens = Number.isFinite(requestedTokens) && requestedTokens > 0
      ? Math.min(50_000, Math.max(1_000, Math.floor(requestedTokens)))
      : this.maxSnapshotTokens

    const frozen = freezeSnapshot(rows, anchorIndex, { maxTokens, estimate: this.estimate })
    const now = this.now()
    const id = shortId('side')
    const snapshotId = shortId('snap')
    const quoteId = shortId('quote')
    // A deleted/replaced anchor keeps the caller's id as provenance but records
    // no seq: the snapshot then ends at the newest surviving message.
    const lostAnchor = located.match === 'none'
    const resolvedMessageId = lostAnchor
      ? (anchorMessageId === undefined ? '' : String(anchorMessageId))
      : (anchorRow?.id ?? (anchorMessageId === undefined ? '' : String(anchorMessageId)))
    const resolvedSeq = lostAnchor ? null : (anchorRow?.seq ?? null)
    const chat = {
      id,
      kind: 'side',
      parentSessionId,
      parentTitle: deriveParentTitle(rows),
      anchorMessageId: resolvedMessageId,
      anchorSeq: resolvedSeq,
      contextSnapshotId: snapshotId,
      contextSnapshot: {
        id: snapshotId,
        parentSessionId,
        anchorMessageId: resolvedMessageId,
        anchorSeq: resolvedSeq,
        fromSeq: frozen.messages[0]?.seq ?? null,
        toSeq: resolvedSeq,
        capturedAt: iso(now),
        messageCount: frozen.messages.length,
        totalMessages: frozen.totalMessages,
        truncatedCount: frozen.truncatedCount,
        strategy: frozen.strategy,
        maxTokens: frozen.maxTokens,
        estimatedTokens: frozen.estimatedTokens,
        anchorMatch: located.match,
        messages: frozen.messages,
      },
      quoteRef: {
        id: quoteId,
        conversationId: id,
        messageId: resolvedMessageId,
        blockId: quote?.blockId === undefined ? undefined : String(quote.blockId),
        exact,
        prefix: quote?.prefix === undefined ? undefined : String(quote.prefix),
        suffix: quote?.suffix === undefined ? undefined : String(quote.suffix),
        startOffset: Number.isInteger(quote?.startOffset) ? quote.startOffset : undefined,
        endOffset: Number.isInteger(quote?.endOffset) ? quote.endOffset : undefined,
        createdAt: iso(now),
      },
      title: typeof title === 'string' && title.trim() !== '' ? title.trim() : deriveSideChatTitle(quote, deriveParentTitle(rows)),
      status: 'idle',
      createdAt: iso(now),
      updatedAt: iso(now),
      messages: [],
    }
    await this.store.put(chat)
    return publicChat(chat)
  }

  /** List summaries for one parent Session. */
  async list(parentSessionId) {
    await this.ready()
    if (typeof parentSessionId !== 'string' || parentSessionId === '') {
      throw new SideChatError(400, 'invalid-parent', '缺少 parentSessionId。')
    }
    this.#session(parentSessionId)
    return this.store.list(parentSessionId).map(publicChatSummary)
  }

  /** Read one chat, scoped to its parent. */
  async get(id, parentSessionId) {
    await this.ready()
    if (typeof parentSessionId !== 'string' || parentSessionId === '') {
      throw new SideChatError(400, 'invalid-parent', '缺少 parentSessionId。')
    }
    return publicChat(this.#owned(id, parentSessionId))
  }

  /** Delete one chat. */
  async delete(id, parentSessionId) {
    await this.ready()
    this.#owned(id, parentSessionId)
    await this.store.delete(id)
    return { id, deleted: true }
  }

  /**
   * Append a user question and stream one answer.
   * @param {string} id - side chat id.
   * @param {string} parentSessionId - parent scope.
   * @param {string} text - question.
   * @param {(event: object) => void} send - SSE sink.
   */
  async turn(id, parentSessionId, text, send) {
    await this.ready()
    const chat = this.#owned(id, parentSessionId)
    if (chat.status === 'running' || this.streams.has(id)) {
      throw new SideChatError(409, 'busy', '该侧边对话正在回答，请先停止或等待完成。')
    }
    const question = typeof text === 'string' ? text.trim() : ''
    if (question === '') throw new SideChatError(400, 'empty-turn', '问题不能为空。')
    if (question.length > MAX_TURN_TEXT) throw new SideChatError(400, 'turn-too-large', '问题过长。')
    chat.messages.push({
      id: shortId('msg'),
      role: 'user',
      content: [{ type: 'text', text: question }],
      createdAt: iso(this.now()),
      status: 'done',
    })
    await this.#run(chat, send)
    return publicChat(chat)
  }

  /** Abort the active answer without deleting the partial reply. */
  async cancel(id, parentSessionId) {
    await this.ready()
    const chat = this.#owned(id, parentSessionId)
    const controller = this.streams.get(id)
    if (controller !== undefined) {
      controller.abort()
      return { id, cancelled: true }
    }
    let changed = false
    for (const message of chat.messages) {
      if (message.status === 'streaming') {
        message.status = 'cancelled'
        changed = true
      }
    }
    if (chat.status === 'running') {
      chat.status = 'idle'
      changed = true
    }
    if (changed) await this.#save(chat)
    return { id, cancelled: changed }
  }

  /**
   * Retry the last failed answer without appending another user message.
   * @param {string} id - side chat id.
   * @param {string} parentSessionId - parent scope.
   * @param {(event: object) => void} send - SSE sink.
   */
  async retry(id, parentSessionId, send) {
    await this.ready()
    const chat = this.#owned(id, parentSessionId)
    if (chat.status === 'running' || this.streams.has(id)) {
      throw new SideChatError(409, 'busy', '该侧边对话正在回答，请先停止。')
    }
    const last = chat.messages[chat.messages.length - 1]
    if (last === undefined) throw new SideChatError(409, 'nothing-to-retry', '没有可重试的回答。')
    if (last.role === 'assistant') {
      if (last.status !== 'error' && last.status !== 'cancelled') {
        throw new SideChatError(409, 'nothing-to-retry', '最后一条回答已成功，无需重试。')
      }
      chat.messages.pop()
    } else if (last.role !== 'user') {
      throw new SideChatError(409, 'nothing-to-retry', '没有可重试的问题。')
    }
    await this.#run(chat, send)
    return publicChat(chat)
  }

  async #save(chat, { quiet = false } = {}) {
    chat.updatedAt = iso(this.now())
    try {
      await this.store.put(chat)
    } catch (error) {
      if (!quiet) throw error
    }
  }

  /** Shared streaming transaction used by both turn and retry. */
  async #run(chat, send) {
    const selection = this.selection()
    if (selection === undefined || typeof selection.provider !== 'string' || selection.provider === '') {
      chat.status = 'error'
      chat.error = '没有可用的默认模型。'
      await this.#save(chat)
      throw new SideChatError(503, 'model-unavailable', chat.error)
    }
    const assistant = {
      id: shortId('msg'),
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      createdAt: iso(this.now()),
      status: 'streaming',
      provider: selection.provider,
      model: selection.model,
    }
    chat.messages.push(assistant)
    chat.status = 'running'
    chat.error = null
    await this.#save(chat)
    const controller = new AbortController()
    this.streams.set(chat.id, controller)
    send({ type: 'start', sideChatId: chat.id, messageId: assistant.id, status: 'running' })
    let lastPersist = Date.now()
    try {
      const messages = buildRequestMessages(chat, selection)
      const iterable = this.stream({
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        messages,
        system: buildSystemPrompt(chat),
        signal: controller.signal,
      })
      let finish
      for await (const chunk of iterable) {
        if (controller.signal.aborted) break
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          assistant.content[0].text += chunk.text
          send({ type: 'delta', sideChatId: chat.id, messageId: assistant.id, text: chunk.text })
          if (Date.now() - lastPersist > 300) {
            lastPersist = Date.now()
            await this.#save(chat, { quiet: true })
          }
        } else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
          send({ type: 'reasoning', sideChatId: chat.id, messageId: assistant.id, text: chunk.text })
        } else if (chunk?.type === 'finish') {
          finish = chunk.reason
        }
      }
      if (controller.signal.aborted) {
        assistant.status = 'cancelled'
        chat.status = 'idle'
        await this.#save(chat)
        send({ type: 'done', sideChatId: chat.id, cancelled: true, chat: publicChat(chat) })
        return
      }
      if (finish?.kind === 'error') {
        throw Object.assign(new Error(finish.failure?.message ?? '模型调用失败。'), { failure: finish.failure })
      }
      if (finish?.kind === 'aborted') {
        assistant.status = 'cancelled'
        chat.status = 'idle'
        await this.#save(chat)
        send({ type: 'done', sideChatId: chat.id, cancelled: true, chat: publicChat(chat) })
        return
      }
      assistant.status = 'done'
      chat.status = 'idle'
      await this.#save(chat)
      send({ type: 'done', sideChatId: chat.id, chat: publicChat(chat) })
    } catch (error) {
      if (controller.signal.aborted) {
        assistant.status = 'cancelled'
        chat.status = 'idle'
        await this.#save(chat)
        send({ type: 'done', sideChatId: chat.id, cancelled: true, chat: publicChat(chat) })
      } else {
        assistant.status = 'error'
        assistant.error = error?.message ?? String(error)
        chat.status = 'error'
        chat.error = assistant.error
        await this.#save(chat)
        send({
          type: 'error', sideChatId: chat.id,
          error: { code: error?.failure?.code ?? 'llm-error', message: assistant.error },
          chat: publicChat(chat),
        })
      }
    } finally {
      this.streams.delete(chat.id)
    }
  }

  /** Test and route helper: reject a turn when the chat is not idle. */
  isRunning(id) {
    return this.streams.has(id)
  }
}

/** Re-export the content helper for route-level validation. */
export { textOfContent }
