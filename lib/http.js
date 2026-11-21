/**
 * Authenticated Fetch routes for the side-chat service.
 *
 * Registered on the Host connection's shared `/api` channel, so the browser
 * request is admitted by the same trust and credential checks as every other
 * DSH API call. Each route owns one exact path; turn and retry answer with
 * server-sent events.
 */
import { SideChatError } from './service.js'

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

function streamResponse(run) {
  const encoder = new TextEncoder()
  let closed = false
  const body = new ReadableStream({
    async start(controller) {
      const send = (event) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          closed = true
        }
      }
      try {
        await run(send)
      } catch (error) {
        send({
          type: 'error',
          error: { code: error?.code ?? 'internal', message: error?.message ?? String(error) },
        })
      } finally {
        if (!closed) {
          closed = true
          try {
            controller.close()
          } catch {
            // The peer may have cancelled the stream.
          }
        }
      }
    },
    cancel() {
      closed = true
    },
  })
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  })
}

async function jsonBody(request) {
  try {
    return await request.json()
  } catch {
    throw new SideChatError(400, 'invalid-json', '请求体不是合法 JSON。')
  }
}

function parentOf(url, body) {
  return typeof body?.parentSessionId === 'string'
    ? body.parentSessionId
    : (url.searchParams.get('parentSessionId') ?? '')
}

/**
 * Build the route list.
 * @param {{ service: import('./service.js').SideChatService }} options - the service.
 */
export function createSideChatFetchRoutes({ service }) {
  const path = name => `${API_PREFIX}/${name}`
  return [
    {
      path: path('list'),
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        const url = new URL(request.url)
        try {
          return json({ chats: await service.list(url.searchParams.get('parentSessionId') ?? '') })
        } catch (error) {
          return errorResponse(error)
        }
      },
    },
    {
      path: path('get'),
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        const url = new URL(request.url)
        try {
          return json({
            chat: await service.get(
              url.searchParams.get('id') ?? '',
              url.searchParams.get('parentSessionId') ?? '',
            ),
          })
        } catch (error) {
          return errorResponse(error)
        }
      },
    },
    {
      path: path('create'),
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        try {
          return json({ chat: await service.create(await jsonBody(request)) })
        } catch (error) {
          return errorResponse(error)
        }
      },
    },
    {
      path: path('turn'),
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        try {
          const body = await jsonBody(request)
          const parentSessionId = parentOf(new URL(request.url), body)
          const chat = await service.get(body.id ?? '', parentSessionId)
          if (chat.status === 'running' || service.isRunning(chat.id)) {
            return json({ code: 'busy', message: '该侧边对话正在回答。' }, 409)
          }
          if (typeof body.text !== 'string' || body.text.trim() === '') {
            return json({ code: 'empty-turn', message: '问题不能为空。' }, 400)
          }
          return streamResponse(send => service.turn(chat.id, parentSessionId, body.text, send))
        } catch (error) {
          return errorResponse(error)
        }
      },
    },
    {
      path: path('retry'),
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        try {
          const body = await jsonBody(request)
          const parentSessionId = parentOf(new URL(request.url), body)
          const chat = await service.get(body.id ?? '', parentSessionId)
          if (chat.status === 'running' || service.isRunning(chat.id)) {
            return json({ code: 'busy', message: '该侧边对话正在回答。' }, 409)
          }
          return streamResponse(send => service.retry(chat.id, parentSessionId, send))
        } catch (error) {
          return errorResponse(error)
        }
      },
    },
    {
      path: path('cancel'),
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        try {
          const body = await jsonBody(request)
          return json(await service.cancel(body.id ?? '', parentOf(new URL(request.url), body)))
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
          const body = await jsonBody(request)
          return json(await service.delete(body.id ?? '', parentOf(new URL(request.url), body)))
        } catch (error) {
          return errorResponse(error)
        }
      },
    },
  ]
}
