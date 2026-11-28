/**
 * Host-side ephemeral side-chat manager.
 *
 * A side chat is a real forked Session with a live Agent: the fork carries the
 * parent prefix up to the selected anchor, the working directory, the agent
 * preset, tools and skills, so the native Conversation can use files and
 * permissions exactly like the main chat. Closing the side panel or quitting
 * the Host disposes the agents and deletes the stored logs.
 */
import {
  deriveParentTitle, messageIdFromBlock, parentMessages, parseSideChatAddress, quoteMessage,
  resolveAnchor, sideChatAddress, titleFromQuote,
} from './core.js'

export class SideChatError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'SideChatError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function logError(logger, message, error) {
  if (logger !== undefined) logger(message, error)
  else console.error(`[side-chat] ${message}`, error)
}

export class NativeSideChatManager {
  /**
   * @param {object} options - injected dependencies (kept explicit for tests).
   * @param {import('./registry.js').EphemeralRegistry} options.registry - durable identity registry.
   * @param {(options: object) => Promise<{ agent: { id: string }, dispose: () => Promise<void> }>} options.createAgent - Host agent factory.
   * @param {(id: string) => object | undefined} options.getSession - live Session lookup.
   * @param {(id: string) => object | undefined} options.getAgent - live Agent lookup.
   * @param {(id: string) => Promise<{ location?: { path?: string } } | undefined>} options.statSession - persistence stat.
   * @param {(id: string) => Promise<{ events: readonly object[] }>} [options.readSessionLog] - live-preferred log read.
   * @param {(events: readonly object[], boundary: number) => Promise<readonly object[]>} options.buildSeed - fork seed builder.
   * @param {() => { provider: string, model: string, reasoningEffort?: string } | undefined} [options.defaultSelection] - initial model route.
   * @param {(session: object) => string | undefined} [options.permissionCurrent] - parent preset.
   * @param {(session: object, name: string) => void} [options.permissionSet] - apply a preset.
   * @param {(session: object) => string | undefined} [options.agentPreset] - parent agent preset.
   * @param {() => number} [options.now] - clock.
   * @param {() => string} [options.idFactory] - child Session id factory.
   * @param {(message: string, error?: unknown) => void} [options.logger] - diagnostics.
   */
  constructor({
    registry, createAgent, getSession, getAgent, statSession, readSessionLog, removePath, buildSeed,
    defaultSelection, permissionCurrent, permissionSet, agentPreset, now = () => Date.now(),
    idFactory = () => `side-${crypto.randomUUID()}`, logger,
  }) {
    this.registry = registry
    this.createAgent = createAgent
    this.getSession = getSession
    this.getAgent = getAgent
    this.statSession = statSession
    this.readSessionLog = readSessionLog
    this.removePath = removePath
    this.buildSeed = buildSeed
    this.defaultSelection = defaultSelection
    this.permissionCurrent = permissionCurrent
    this.permissionSet = permissionSet
    this.agentPreset = agentPreset
    this.now = now
    this.idFactory = idFactory
    this.logger = logger
    this.handles = new Map()
  }

  async ready() {
    await this.registry.load()
    return this
  }

  #ownedParent(parentSessionId) {
    const parent = this.getSession(parentSessionId)
    if (parent === undefined || parent === null) {
      throw new SideChatError(404, 'parent-not-found', '父对话不存在或尚未加载。', { parentSessionId })
    }
    return parent
  }

  #ownedEntry(sessionId, parentSessionId) {
    const entry = this.registry.get(sessionId)
    if (entry === undefined) throw new SideChatError(404, 'side-chat-not-found', '侧边对话不存在。', { sessionId })
    if (parentSessionId !== undefined && entry.parentSessionId !== parentSessionId) {
      throw new SideChatError(404, 'side-chat-not-found', '侧边对话不属于该父对话。', { sessionId })
    }
    return entry
  }

  /**
   * Create a forked Session, inject the quote boundary, inherit the parent's
   * permission preset and return the sidebar resource address.
   */
  async create({ parentSessionId, quote, anchorMessageId, title } = {}) {
    await this.ready()
    if (typeof parentSessionId !== 'string' || parentSessionId === '') {
      throw new SideChatError(400, 'invalid-parent', '缺少 parentSessionId。')
    }
    const exact = typeof quote?.exact === 'string' ? quote.exact : ''
    if (exact.trim() === '') throw new SideChatError(400, 'empty-quote', '引用原文不能为空。')
    if (exact.length > 20_000) throw new SideChatError(400, 'quote-too-large', '引用原文过长。')

    const parent = this.#ownedParent(parentSessionId)
    const rows = parentMessages(parent)
    const parentTitle = deriveParentTitle(rows)
    const resolved = resolveAnchor(
      parent,
      quote,
      anchorMessageId ?? messageIdFromBlock(quote?.blockId),
    )
    const boundary = resolved.boundary
    const snapshot = this.readSessionLog === undefined
      ? { events: [] }
      : await this.readSessionLog(parent.id)
    const events = snapshot.events ?? []
    const seed = boundary >= 0 ? await this.buildSeed(events, boundary) : []
    const sessionId = this.idFactory()
    const createdAt = new Date(this.now()).toISOString()
    const sideTitle = typeof title === 'string' && title.trim() !== '' ? title.trim() : titleFromQuote(quote, parentTitle)
    const entry = {
      sessionId,
      parentSessionId,
      parentTitle,
      anchorMessageId: resolved.anchorMessageId || String(anchorMessageId ?? ''),
      title: sideTitle,
      createdAt,
    }
    // Reserve the identity before creating anything so a crash still leaves a
    // purgeable registry row.
    await this.registry.put(entry)

    let handle
    try {
      const parentAgent = this.getAgent?.(parentSessionId)
      const selection = parentAgent?.model?.current?.() ?? this.defaultSelection?.()
      const inheritedPreset = this.agentPreset?.(parent) ?? parent.header?.agentPreset
      const meta = {
        isSeeded: seed.length > 0,
        ...(typeof parent.header?.cwd === 'string' ? { cwd: parent.header.cwd } : {}),
        ...(typeof inheritedPreset === 'string' && inheritedPreset !== '' ? { agentPreset: inheritedPreset } : {}),
      }
      handle = await this.createAgent({
        sessionId,
        seed,
        inheritedEventCount: boundary >= 0 ? boundary + 1 : 0,
        meta,
        // Compose the child's scoped world from the parent's live preset. This
        // is what gives the side chat the same tools, prompt sections and
        // skills as the main conversation; without it the child would run with
        // an empty host composition.
        setup: (agentCtx) => {
          const presets = agentCtx.get('agentPresets')
          if (presets === undefined) return
          if (parentAgent !== undefined) {
            presets.composeFrom(agentCtx, parentAgent.ctx)
          } else if (typeof inheritedPreset === 'string' && inheritedPreset !== '') {
            return presets.mount(agentCtx, inheritedPreset)
          }
        },
        ...(selection === undefined || selection === null
          ? {}
          : {
            agentOptions: {
              provider: selection.provider,
              model: selection.model,
              ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
            },
          }),
      })
      this.handles.set(sessionId, handle)
      // Record the parent's live route on the child so the native composer
      // opens with the same API/model/effort instead of "select a model".
      if (selection !== undefined && selection !== null) {
        try {
          handle.agent.model.select({
            provider: selection.provider,
            model: selection.model,
            ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
          })
        } catch (error) {
          logError(this.logger, `could not inherit model selection for ${sessionId}`, error)
        }
      }
      const child = this.getSession(sessionId)
      if (child === undefined || child === null) throw new Error('forked Session is not live')
      child.append('user/message', {
        id: `side-quote-${crypto.randomUUID()}`,
        role: 'user',
        content: [{
          type: 'text',
          text: quoteMessage({
            parentTitle,
            anchorMessageId: entry.anchorMessageId,
            exact,
            prefix: quote?.prefix,
            suffix: quote?.suffix,
          }),
        }],
        source: { kind: 'user' },
      }, { surfaceOp: 'append' })

      // Inherit the parent's permission preset (including the Auto review
      // preset when the parent is currently using it).
      try {
        const preset = this.permissionCurrent?.(parent)
        if (preset !== undefined && preset !== '' && preset !== 'custom' && this.permissionSet !== undefined) {
          this.permissionSet(child, preset)
        }
      } catch (error) {
        logError(this.logger, `could not inherit permission preset for ${sessionId}`, error)
      }

      return {
        sessionId,
        parentSessionId,
        parentTitle,
        title: sideTitle,
        anchorMessageId: entry.anchorMessageId,
        boundary,
        address: sideChatAddress({ childSessionId: sessionId, parentSessionId, title: sideTitle }),
      }
    } catch (error) {
      this.handles.delete(sessionId)
      try {
        await handle?.dispose()
      } catch (disposeError) {
        logError(this.logger, `cleanup after failed create ${sessionId}`, disposeError)
      }
      await this.registry.remove(sessionId)
      await this.#removeLog(sessionId)
      throw error
    }
  }

  /** List registry rows for one parent. */
  async list(parentSessionId) {
    await this.ready()
    if (typeof parentSessionId !== 'string' || parentSessionId === '') {
      throw new SideChatError(400, 'invalid-parent', '缺少 parentSessionId。')
    }
    this.#ownedParent(parentSessionId)
    return this.registry.list(parentSessionId).map(entry => ({ ...entry }))
  }

  /** Delete one side chat: stop its Agent, remove its log, forget its identity. */
  async delete(sessionId, parentSessionId) {
    await this.ready()
    this.#ownedEntry(sessionId, parentSessionId)
    const handle = this.handles.get(sessionId)
    if (handle !== undefined) {
      this.handles.delete(sessionId)
      try {
        await handle.dispose()
      } catch (error) {
        logError(this.logger, `dispose ${sessionId} failed`, error)
      }
    } else if (this.getAgent?.(sessionId) !== undefined) {
      throw new SideChatError(409, 'side-chat-live', '侧边对话仍由另一个宿主实例持有，无法安全删除。', { sessionId })
    }
    await this.#removeLog(sessionId)
    await this.registry.remove(sessionId)
    return { sessionId, deleted: true }
  }

  /** Delete every side chat belonging to one parent (the panel close path). */
  async purge(parentSessionId) {
    await this.ready()
    if (typeof parentSessionId !== 'string' || parentSessionId === '') {
      throw new SideChatError(400, 'invalid-parent', '缺少 parentSessionId。')
    }
    const entries = this.registry.list(parentSessionId)
    const deleted = []
    const failed = []
    for (const entry of entries) {
      try {
        await this.delete(entry.sessionId, parentSessionId)
        deleted.push(entry.sessionId)
      } catch (error) {
        failed.push({ sessionId: entry.sessionId, message: error?.message ?? String(error) })
      }
    }
    return { deleted, failed }
  }

  /** Remove logs left by a previous process. Live entries are left alone. */
  async purgeStale() {
    await this.ready()
    for (const entry of this.registry.list()) {
      if (this.getSession?.(entry.sessionId) !== undefined || this.getAgent?.(entry.sessionId) !== undefined) continue
      await this.#removeLog(entry.sessionId)
      await this.registry.remove(entry.sessionId)
    }
  }

  /** Best-effort teardown for Host/plugin unload. */
  async disposeAll() {
    const entries = this.registry.list()
    for (const entry of entries) {
      const handle = this.handles.get(entry.sessionId)
      this.handles.delete(entry.sessionId)
      try {
        await handle?.dispose()
      } catch (error) {
        logError(this.logger, `dispose ${entry.sessionId} on unload failed`, error)
      }
      await this.#removeLog(entry.sessionId)
    }
    await this.registry.clear().catch(() => {})
  }

  async #removeLog(sessionId) {
    try {
      const stat = await this.statSession(sessionId)
      const path = stat?.location?.path
      if (typeof path === 'string' && path !== '') await this.removePath(path)
    } catch (error) {
      logError(this.logger, `remove log for ${sessionId} failed`, error)
    }
  }
}

/** Re-export address parsing for route/client tests. */
export { parseSideChatAddress }
