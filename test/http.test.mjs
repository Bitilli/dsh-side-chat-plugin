import assert from 'node:assert/strict'
import test from 'node:test'
import { createSideChatFetchRoutes } from '../lib/http.js'

function managerStub() {
  const calls = []
  return {
    calls,
    async create(input) {
      calls.push({ op: 'create', input })
      return {
        sessionId: 'side-1', parentSessionId: input.parentSessionId,
        parentTitle: 'Parent', title: '侧聊 · quote', anchorMessageId: 'm2', boundary: 8,
        address: 'dsh-resource://sidechat/session/side-1?parent=s1&title=x',
      }
    },
    async list(parentSessionId) {
      calls.push({ op: 'list', parentSessionId })
      return [{ sessionId: 'side-1', parentSessionId, parentTitle: 'Parent', anchorMessageId: 'm2', title: '侧聊 · quote', createdAt: 'x' }]
    },
    async delete(sessionId, parentSessionId) {
      calls.push({ op: 'delete', sessionId, parentSessionId })
      return { sessionId, deleted: true }
    },
    async purge(parentSessionId) {
      calls.push({ op: 'purge', parentSessionId })
      return { deleted: ['side-1'], failed: [] }
    },
  }
}

function call(routes, name, init, query = '') {
  const route = routes.find(entry => entry.path === `/api/side-chat/${name}`)
  return route.fetch(new Request(`http://localhost/api/side-chat/${name}${query}`, init))
}

test('routes create, list, delete and purge with addresses', async () => {
  const manager = managerStub()
  const routes = createSideChatFetchRoutes({ manager })
  assert.deepEqual(routes.map(route => route.path), [
    '/api/side-chat/create', '/api/side-chat/list', '/api/side-chat/delete', '/api/side-chat/purge',
  ])
  for (const route of routes) assert.equal(route.requestBody, 'buffered')

  const created = await call(routes, 'create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parentSessionId: 's1', quote: { exact: 'quote' } }),
  })
  assert.equal(created.status, 200)
  assert.equal((await created.json()).sessionId, 'side-1')

  const list = await call(routes, 'list', { method: 'GET' }, '?parentSessionId=s1')
  assert.equal(list.status, 200)
  const listed = await list.json()
  assert.equal(listed.sessions.length, 1)
  assert.match(listed.sessions[0].address, /^dsh-resource:\/\/sidechat\/session\/side-1\?/u)

  const deleted = await call(routes, 'delete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'side-1', parentSessionId: 's1' }),
  })
  assert.deepEqual(await deleted.json(), { sessionId: 'side-1', deleted: true })

  const purged = await call(routes, 'purge', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parentSessionId: 's1' }),
  })
  assert.deepEqual(await purged.json(), { deleted: ['side-1'], failed: [] })
})

test('route errors keep their status and code', async () => {
  const manager = {
    async create() {
      const error = new Error('parent missing')
      error.name = 'SideChatError'
      error.status = 404
      error.code = 'parent-not-found'
      error.details = {}
      throw error
    },
  }
  // Build a real SideChatError through the manager module instead of a lookalike.
  const { createSideChatFetchRoutes: build } = await import('../lib/http.js')
  const { SideChatError } = await import('../lib/manager.js')
  manager.create = async () => { throw new SideChatError(404, 'parent-not-found', 'parent missing') }
  const routes = build({ manager })
  const response = await call(routes, 'create', { method: 'POST', body: '{}' })
  assert.equal(response.status, 404)
  assert.equal((await response.json()).code, 'parent-not-found')
})
