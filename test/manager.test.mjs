import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { NativeSideChatManager, SideChatError } from '../lib/manager.js'
import { EphemeralRegistry } from '../lib/registry.js'

function parentSession() {
  const rows = [
    { id: 'm1', role: 'user', text: 'alpha question', seq: 3 },
    { id: 'm2', role: 'assistant', text: 'alpha answer with detail', seq: 8 },
  ]
  const messages = rows.map(row => ({
    id: row.id,
    role: row.role,
    content: [{ type: 'text', text: row.text }],
    source: row.role === 'user' ? { kind: 'user' } : { kind: 'model', provider: 'p', model: 'm' },
  }))
  return {
    id: 's1',
    header: { cwd: 'D:/work', agentPreset: 'standard' },
    deriveMessages: () => messages,
    surface: { nodes: rows.map(row => row.seq) },
    eventAt: seq => {
      const row = rows.find(candidate => candidate.seq === seq)
      return row?.role === 'user'
        ? { type: 'user/message', data: { id: row.id } }
        : { type: 'assistant/message', data: { message: { id: row?.id } } }
    },
  }
}

function childSession(id) {
  return {
    id,
    appended: [],
    append(type, data) {
      this.appended.push({ type, data })
      return { type, data }
    },
  }
}

async function makeHarness() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-side-chat-native-'))
  const registry = new EphemeralRegistry({ dir })
  await registry.load()
  const sessions = new Map([['s1', parentSession()]])
  const handles = []
  const removed = []
  const seeds = []
  const permissions = []
  const agentOptions = []
  let child = null
  const manager = new NativeSideChatManager({
    registry,
    createAgent: async (options) => {
      agentOptions.push(options)
      child = childSession(options.sessionId)
      sessions.set(options.sessionId, child)
      const handle = {
        agent: { id: options.sessionId },
        async dispose() {
          handles.push(options.sessionId)
          sessions.delete(options.sessionId)
        },
      }
      handles.push(handle)
      return handle
    },
    getSession: id => sessions.get(id),
    getAgent: id => (sessions.has(id) ? { id } : undefined),
    statSession: async id => ({ location: { path: `D:/logs/${id}.jsonl.zst` } }),
    readSessionLog: async () => ({ events: [{ type: 'user/message', seq: 3, time: 1, data: { id: 'm1' } }] }),
    removePath: async target => { removed.push(target) },
    buildSeed: async (events, boundary) => {
      seeds.push({ events, boundary })
      return [{ type: 'session/end-seed', seq: boundary + 1, time: 1, data: { inherited: true } }]
    },
    defaultSelection: () => ({ provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'high' }),
    permissionCurrent: () => 'auto',
    permissionSet: (_session, preset) => { permissions.push(preset) },
    now: () => 1_700_000_000_000,
    idFactory: () => 'side-test-1',
    logger: () => {},
  })
  await manager.ready()
  return {
    dir, registry, manager, sessions, handles, removed, seeds, permissions,
    get child() { return child },
    agentOptions,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

test('create builds a real fork with quote, permission and address', async () => {
  const h = await makeHarness()
  try {
    const created = await h.manager.create({
      parentSessionId: 's1',
      quote: { exact: 'alpha answer', prefix: 'alpha ', suffix: ' with detail' },
    })
    assert.equal(created.sessionId, 'side-test-1')
    assert.equal(created.parentSessionId, 's1')
    assert.equal(created.boundary, 8)
    assert.equal(created.anchorMessageId, 'm2')
    assert.match(created.address, /dsh-resource:\/\/sidechat\/session\/side-test-1\?/u)
    assert.equal(h.seeds[0].boundary, 8)
    assert.equal(h.permissions[0], 'auto')
    assert.equal(h.agentOptions[0].meta.cwd, 'D:/work')
    assert.equal(h.agentOptions[0].meta.agentPreset, 'standard')
    assert.equal(typeof h.agentOptions[0].setup, 'function')
    assert.equal(h.agentOptions[0].inheritedEventCount, 9)
    assert.equal(h.child.appended.length, 1)
    assert.equal(h.child.appended[0].type, 'user/message')
    assert.match(h.child.appended[0].data.content[0].text, /alpha answer/u)
    const entry = h.registry.get('side-test-1')
    assert.equal(entry.parentSessionId, 's1')
    assert.equal(entry.anchorMessageId, 'm2')
  } finally {
    await h.cleanup()
  }
})

test('delete disposes the agent, removes the log and forgets the identity', async () => {
  const h = await makeHarness()
  try {
    await h.manager.create({ parentSessionId: 's1', quote: { exact: 'alpha answer' } })
    const result = await h.manager.delete('side-test-1', 's1')
    assert.equal(result.deleted, true)
    assert.equal(h.handles.some(handle => typeof handle === 'object'), true)
    assert.deepEqual(h.removed, ['D:/logs/side-test-1.jsonl.zst'])
    assert.equal(h.registry.get('side-test-1'), undefined)
    assert.equal(h.sessions.has('side-test-1'), false)
  } finally {
    await h.cleanup()
  }
})

test('purge deletes every side chat for one parent only', async () => {
  const h = await makeHarness()
  try {
    await h.manager.create({ parentSessionId: 's1', quote: { exact: 'alpha answer' } })
    // Add a second identity by hand to exercise the parent filter.
    await h.registry.put({
      sessionId: 'side-other', parentSessionId: 's2', parentTitle: 'Other',
      title: 'other', createdAt: '2026-01-01T00:00:00.000Z', anchorMessageId: '',
    })
    const result = await h.manager.purge('s1')
    assert.deepEqual(result.deleted, ['side-test-1'])
    assert.equal(h.registry.get('side-test-1'), undefined)
    assert.notEqual(h.registry.get('side-other'), undefined)
  } finally {
    await h.cleanup()
  }
})

test('cross-parent delete and missing parent are rejected', async () => {
  const h = await makeHarness()
  try {
    await h.manager.create({ parentSessionId: 's1', quote: { exact: 'alpha answer' } })
    await assert.rejects(
      () => h.manager.delete('side-test-1', 's2'),
      error => error instanceof SideChatError && error.status === 404,
    )
    await assert.rejects(
      () => h.manager.create({ parentSessionId: 'missing', quote: { exact: 'x' } }),
      error => error instanceof SideChatError && error.status === 404,
    )
  } finally {
    await h.cleanup()
  }
})

test('stale registry rows delete logs but live rows are left alone', async () => {
  const h = await makeHarness()
  try {
    await h.registry.put({
      sessionId: 'side-stale', parentSessionId: 's1', parentTitle: 'P',
      title: 'stale', createdAt: '2026-01-01T00:00:00.000Z', anchorMessageId: '',
    })
    await h.registry.put({
      sessionId: 'side-live', parentSessionId: 's1', parentTitle: 'P',
      title: 'live', createdAt: '2026-01-01T00:00:00.000Z', anchorMessageId: '',
    })
    h.sessions.set('side-live', childSession('side-live'))
    await h.manager.purgeStale()
    assert.equal(h.registry.get('side-stale'), undefined)
    assert.notEqual(h.registry.get('side-live'), undefined)
    assert.deepEqual(h.removed, ['D:/logs/side-stale.jsonl.zst'])
  } finally {
    await h.cleanup()
  }
})
