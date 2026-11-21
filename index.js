/**
 * Host half of the Side chat plugin.
 *
 * It owns durable side-chat records, the frozen parent-context snapshot, the
 * model turns, and the authenticated Fetch/SSE surface the browser half talks
 * to. The parent Session is never appended to or otherwise mutated here.
 */
import os from 'node:os'
import path from 'node:path'
import { SideChatService } from './lib/service.js'
import { SideChatStore } from './lib/store.js'
import { createSideChatFetchRoutes } from './lib/http.js'
import { heuristicTokens } from './lib/core.js'

/** Host plugin name shown by the Loader. */
export const name = 'side-chat'

/** Services required before the plugin can answer requests. */
export const inject = ['sessions', 'llm', 'connection']

function storageDirectory() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const profile = process.env.DSH_PROFILE
  return path.join(home, 'side-chat', typeof profile === 'string' && profile !== '' ? profile : 'default')
}

/**
 * Plugin entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 */
export function apply(ctx) {
  const store = new SideChatStore({ dir: storageDirectory() })
  const tokenMeter = ctx.get('tokenMeter')
  const service = new SideChatService({
    store,
    getSession: id => ctx.sessions.get(id),
    stream: options => ctx.llm.stream(options),
    selection: () => ctx.get('agentDefaultModel')?.currentSelection(),
    estimate: row => {
      if (tokenMeter === undefined) return heuristicTokens(row.text)
      try {
        return tokenMeter.estimateMessage({
          id: row.id,
          role: row.role,
          content: [{ type: 'text', text: row.text }],
          source: row.role === 'user'
            ? { kind: 'user' }
            : { kind: 'model', provider: 'side-chat', model: 'side-chat' },
        })
      } catch {
        return heuristicTokens(row.text)
      }
    },
    maxSnapshotTokens: 8_000,
  })

  // The route handlers await service readiness themselves, so a request that
  // arrives before the store has loaded still settles on the same promise.
  const routes = createSideChatFetchRoutes({ service })
  ctx.effect(() => {
    const disposers = []
    for (const route of routes) {
      try {
        disposers.push(ctx.connection.fetch.register(route))
      } catch (error) {
        // A duplicate path means an earlier activation of this same plugin is
        // still mounted (for example during a live reload). Keep the remaining
        // routes and report the collision instead of failing the whole plugin.
        console.error(`[side-chat] route ${route.path} was not registered`, error)
      }
    }
    return () => {
      for (const dispose of disposers) void dispose()
    }
  }, 'side-chat: fetch routes')

  ctx.effect(() => () => {
    for (const controller of service.streams.values()) controller.abort()
  }, 'side-chat: abort streams on unload')
}
