import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createSideChatFetchRoutes } from '../lib/http.js'
import { SideChatService } from '../lib/service.js'
import { SideChatStore } from '../lib/store.js'

function makeSession() {
  const rows = [
    { id: 'm1', role: 'user', text: 'where is the alpha config?' },
    { id: 'm2', role: 'assistant', text: 'The alpha config lives in config/alpha.json.' },
    { id: 'm3', role: 'user', text: 'and beta?' },
  ]
  const messages = rows.map(row => ({
    id: row.id,
    role: row.role,
    content: [{ type: 'text', text: row.text }],
    source: row.role === 'user' ? { kind: 'user' } : { kind: 'model', provider: 'fake', model: 'fake' },
  }))
  return { id: 's1', deriveMessages: () => messages, surface: { nodes: [] }, eventAt: () => undefined }
}

function parseFrames(text) {
  return text
    .split(/\n\n/u)
    .map(block => block.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'))
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

async function start() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-side-chat-http-'))
  const sessions = new Map([['s1', makeSession()]])
  const service = new SideChatService({
    store: new SideChatStore({ dir }),
    getSession: id => sessions.get(id),
    stream: () => (async function* () {
      yield { type: 'text-delta', text: 'side ' }
      yield { type: 'text-delta', text: 'answer' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
    selection: () => ({ provider: 'fake', model: 'fake' }),
  })
  const routes = createSideChatFetchRoutes({ service })
  const route = name => routes.find(entry => entry.path === `/api/side-chat/${name}`)
  const call = (name, init, query = '') => route(name).fetch(new Request(`http://localhost/api/side-chat/${name}${query}`, init))
  return {
    route, call, service,
    close: () => rm(dir, { recursive: true, force: true }),
  }
}

const jsonHeaders = { 'content-type': 'application/json' }

test('every route is an exact path with a declared method', async () => {
  const server = await start()
  try {
    assert.deepEqual(server.route('list').methods, ['GET'])
    assert.deepEqual(server.route('create').methods, ['POST'])
    for (const name of ['list', 'get', 'create', 'turn', 'retry', 'cancel', 'delete']) {
      const route = server.route(name)
      assert.equal(route.path, `/api/side-chat/${name}`)
      assert.equal(route.requestBody, 'buffered')
    }
  } finally {
    await server.close()
  }
})

test('create, list, get, stream and cross-parent 404 through Fetch routes', async () => {
  const server = await start()
  try {
    const created = await server.call('create', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        parentSessionId: 's1',
        quote: { exact: 'alpha config lives', prefix: 'The ', suffix: ' in config/alpha.json.' },
      }),
    })
    assert.equal(created.status, 200)
    const createdBody = await created.json()
    assert.equal(createdBody.chat.anchorMessageId, 'm2')
    assert.equal(createdBody.chat.contextSnapshot.messageCount, 2)

    const list = await server.call('list', { method: 'GET' }, '?parentSessionId=s1')
    assert.equal(list.status, 200)
    assert.equal((await list.json()).chats.length, 1)
    assert.equal((await server.call('list', { method: 'GET' })).status, 400)

    const wrongParent = await server.call('get', { method: 'GET' }, `?id=${createdBody.chat.id}&parentSessionId=s2`)
    assert.equal(wrongParent.status, 404)

    const turn = await server.call('turn', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ id: createdBody.chat.id, parentSessionId: 's1', text: 'summarize it' }),
    })
    assert.equal(turn.status, 200)
    assert.match(turn.headers.get('content-type') ?? '', /text\/event-stream/u)
    const frames = parseFrames(await turn.text())
    assert.equal(frames[0].type, 'start')
    assert.equal(frames.some(frame => frame.type === 'delta' && frame.text === 'side '), true)
    const done = frames.at(-1)
    assert.equal(done.type, 'done')
    assert.equal(done.chat.messages.length, 2)
    assert.equal(done.chat.messages[0].content[0].text, 'summarize it')
    assert.equal(done.chat.messages[1].content[0].text, 'side answer')

    const detail = await server.call('get', { method: 'GET' }, `?id=${createdBody.chat.id}&parentSessionId=s1`)
    assert.equal((await detail.json()).chat.status, 'idle')
  } finally {
    await server.close()
  }
})

test('a busy side chat refuses a second concurrent turn', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-side-chat-busy-'))
  const session = makeSession()
  const service = new SideChatService({
    store: new SideChatStore({ dir }),
    getSession: () => session,
    stream: () => (async function* () {
      await new Promise(resolve => setTimeout(resolve, 150))
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
    selection: () => ({ provider: 'fake', model: 'fake' }),
  })
  const chat = await service.create({ parentSessionId: 's1', quote: { exact: 'alpha config' } })
  const routes = createSideChatFetchRoutes({ service })
  const turn = routes.find(entry => entry.path === '/api/side-chat/turn')
  const url = 'http://localhost/api/side-chat/turn'
  try {
    const first = turn.fetch(new Request(url, {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ id: chat.id, parentSessionId: 's1', text: 'one' }),
    }))
    await new Promise(resolve => setTimeout(resolve, 40))
    const second = await turn.fetch(new Request(url, {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ id: chat.id, parentSessionId: 's1', text: 'two' }),
    }))
    assert.equal(second.status, 409)
    await (await first).text()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
