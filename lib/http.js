/**
 * Authenticated Fetch routes for ephemeral native side chats.
 *
 * The browser only creates, lists and purges side-chat identities here; every
 * message turn goes through the existing Session Controller because a side chat
 * is a real forked Session.
 */
import { SideChatError } from './manager.js'
import { sideChatAddress } from './core.js'

export const API_PREFIX = '/api/side-chat'

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function errorResponse(error) {
  if (error instanceof SideChatError) {
    return json({ code: error.code, message: error.message, ...error.details }, error.status)
  }
  return json({ code: 'internal', message: error?.message ?? String(error) }, 500)
}

async function bodyOf(request) {
  try {
    return await request.json()
  } catch {
    throw new SideChatError(400, 'invalid-json', '请求体不是合法 JSON。')
  }
}

function withAddress(entry) {
  return {
    ...entry,
    address: sideChatAddress({
      childSessionId: entry.sessionId,
      parentSessionId: entry.parentSessionId,
      title: entry.title,
    }),
  }
}

/**
 * Build the exact route list.
 * @param {{ manager: import('./manager.js').NativeSideChatManager }} options - manager.
 */
export function createSideChatFetchRoutes({ manager }) {
  const path = name => `${API_PREFIX}/${name}`
  return [
    {
      path: path('create'),
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        try {
          const result = await manager.create(await bodyOf(request))
          return json(result)
        } catch (error) {
          return errorResponse(error)
        }
      },
    },
    {
      path: path('list'),
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        const url = new URL(request.url)
        try {
          const entries = await manager.list(url.searchParams.get('parentSessionId') ?? '')
          return json({ sessions: entries.map(withAddress) })
        } catch (error) {
          return errorResponse(error)
        }
      },
    },
    {
      path: path('delete'),
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        try {
          const body = await bodyOf(request)
          return json(await manager.delete(body.sessionId ?? '', body.parentSessionId ?? ''))
        } catch (error) {
          return errorResponse(error)
        }
      },
    },
    {
      path: path('purge'),
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        try {
          const body = await bodyOf(request)
          return json(await manager.purge(body.parentSessionId ?? ''))
        } catch (error) {
          return errorResponse(error)
        }
      },
    },
  ]
}
