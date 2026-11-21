import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { SideChatService, SideChatError } from '../lib/service.js'
import { SideChatStore } from '../lib/store.js'

const ROWS = [
  { id: 'm1', role: 'user', text: 'alpha question' },
  { id: 'm2', role: 'assistant', text: 'alpha answer with detail' },
  { id: 'm3', role: 'user', text: 'beta question' },
  { id: 'm4', role: 'assistant', text: 'beta answer' },
]

function makeSession(rows = ROWS) {
  const messages = rows.map(row => ({
    id: row.id,
    role: row.role,
    content: [{ type: 'text', text: row.text }],
    source: row.role === 'user' ? { kind: 'user' } : { kind: 'model', provider: 'fake', model: 'fake' },
  }))
  return {
    id: 's1',
    deriveMessages: () => messages,
    surface: { nodes: [] },
    eventAt: () => undefined,
    rows,
  }
}

async function context() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-side-chat-'))
  const store = new SideChatStore({ dir, now: () => 1_700_000_000_000 })
  const sessions = new Map([['s1', makeSession()]])
  const calls = []
  let mode = 'text'
  const stream = options => {
    calls.push(options)
    return (async function* () {
      if (mode === 'error') {
        yield { type: 'text-delta', text: 'partial ' }
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'BOOM' } } }
        return
      }
      if (mode === 'slow') {
        yield { type: 'text-delta', text: 'partial ' }
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 500)
          options.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        })
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'text-delta', text: 'answer ' }
      yield { type: 'text-delta', text: 'text' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
  const service = new SideChatService({
    store,
    getSession: id => sessions.get(id),
    stream,
    selection: () => ({ provider: 'fake', model: 'fake' }),
    now: () => 1_700_000_000_000,
  })
  return {
    dir, store, service, sessions, calls,
    setMode: next => { mode = next },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

test('create freezes the parent prefix and never mutates the parent', async () => {
  const ctx = await context()
  try {
    const parent = ctx.sessions.get('s1')
    const before = JSON.stringify(parent.deriveMessages())
    const chat = await ctx.service.create({
      parentSessionId: 's1',
      anchorMessageId: 'm2',
      quote: { exact: 'alpha answer', prefix: 'alpha ', suffix: ' with detail', startOffset: 14, endOffset: 26 },
    })
    assert.equal(chat.kind, 'side')
    assert.equal(chat.parentSessionId, 's1')
    assert.equal(chat.anchorMessageId, 'm2')
    assert.equal(chat.contextSnapshot.messageCount, 2)
    assert.equal(chat.contextSnapshot.anchorMatch, 'id')
    assert.equal(chat.quoteRef.exact, 'alpha answer')
    assert.equal(chat.quoteRef.conversationId, chat.id)
    assert.deepEqual(JSON.parse(JSON.stringify(parent.deriveMessages())), JSON.parse(before))
    assert.equal(parent.deriveMessages().length, ROWS.length)
  } finally {
    await ctx.cleanup()
  }
})

test('parent messages added after creation never enter the frozen snapshot', async () => {
  const ctx = await context()
  try {
    const chat = await ctx.service.create({ parentSessionId: 's1', quote: { exact: 'alpha answer' } })
    const parent = ctx.sessions.get('s1')
    parent.deriveMessages = () => [...makeSession(ROWS).deriveMessages(), {
      id: 'm5', role: 'user', content: [{ type: 'text', text: 'delta after side chat' }], source: { kind: 'user' },
    }]
    const prompt = (await import('../lib/core.js')).buildSystemPrompt(chat)
    assert.equal(prompt.includes('delta after side chat'), false)
    const messages = (await import('../lib/core.js')).buildRequestMessages(chat, { provider: 'fake', model: 'fake' })
    assert.equal(messages.some(message => JSON.stringify(message).includes('delta after side chat')), false)
  } finally {
    await ctx.cleanup()
  }
})

test('two side chats keep isolated snapshots and messages', async () => {
  const ctx = await context()
  try {
    const alpha = await ctx.service.create({ parentSessionId: 's1', quote: { exact: 'alpha answer' } })
    const beta = await ctx.service.create({ parentSessionId: 's1', quote: { exact: 'beta answer' } })
    assert.notEqual(alpha.id, beta.id)
    assert.notEqual(alpha.contextSnapshotId, beta.contextSnapshotId)
    await ctx.service.turn(alpha.id, 's1', 'only in alpha', () => {})
    const alphaDetail = await ctx.service.get(alpha.id, 's1')
    const betaDetail = await ctx.service.get(beta.id, 's1')
    assert.equal(alphaDetail.messages.length, 2)
    assert.equal(betaDetail.messages.length, 0)
    assert.equal(JSON.stringify(alphaDetail).includes('alpha answer'), true)
    assert.equal(JSON.stringify(alphaDetail).includes('beta answer'), false)
    assert.equal(JSON.stringify(betaDetail).includes('only in alpha'), false)
  } finally {
    await ctx.cleanup()
  }
})

test('side chats survive a store reload', async () => {
  const ctx = await context()
  try {
    const chat = await ctx.service.create({ parentSessionId: 's1', quote: { exact: 'beta answer' } })
    await ctx.service.turn(chat.id, 's1', 'persist me', () => {})
    const reopened = new SideChatService({
      store: new SideChatStore({ dir: ctx.dir }),
      getSession: ctx.sessions.get.bind(ctx.sessions),
      stream: () => (async function* () {})(),
      selection: () => ({ provider: 'fake', model: 'fake' }),
    })
    const detail = await reopened.get(chat.id, 's1')
    assert.equal(detail.messages.length, 2)
    assert.equal(detail.messages[0].content[0].text, 'persist me')
    assert.equal(detail.quoteRef.exact, 'beta answer')
  } finally {
    await ctx.cleanup()
  }
})

test('an anchor whose text changed still produces a safe snapshot', async () => {
  const ctx = await context()
  try {
    const chat = await ctx.service.create({
      parentSessionId: 's1',
      anchorMessageId: 'm-deleted',
      quote: { exact: 'text that no longer exists', prefix: 'nothing', suffix: 'nothing' },
    })
    assert.equal(chat.contextSnapshot.anchorMatch, 'none')
    assert.equal(chat.anchorMessageId, 'm-deleted')
    assert.equal(chat.contextSnapshot.messages.length, 4)
    assert.equal(chat.quoteRef.exact, 'text that no longer exists')
  } finally {
    await ctx.cleanup()
  }
})

test('a different parent id cannot read a side chat', async () => {
  const ctx = await context()
  try {
    const chat = await ctx.service.create({ parentSessionId: 's1', quote: { exact: 'alpha answer' } })
    await assert.rejects(
      () => ctx.service.get(chat.id, 's2'),
      error => error instanceof SideChatError && error.status === 404 && error.code === 'side-chat-not-found',
    )
    await assert.rejects(
      () => ctx.service.list('s2'),
      error => error instanceof SideChatError && error.status === 404 && error.code === 'parent-not-found',
    )
    await assert.rejects(
      () => ctx.service.turn(chat.id, 's2', 'intrude', () => {}),
      error => error instanceof SideChatError && error.status === 404,
    )
  } finally {
    await ctx.cleanup()
  }
})

test('cancel keeps the partial answer and retry does not duplicate the question', async () => {
  const ctx = await context()
  try {
    const chat = await ctx.service.create({ parentSessionId: 's1', quote: { exact: 'alpha answer' } })
    ctx.setMode('slow')
    const events = []
    const pending = ctx.service.turn(chat.id, 's1', 'slow question', event => events.push(event))
    await new Promise(resolve => setTimeout(resolve, 40))
    const cancellation = await ctx.service.cancel(chat.id, 's1')
    assert.equal(cancellation.cancelled, true)
    const afterCancel = await pending
    assert.equal(afterCancel.status, 'idle')
    assert.equal(afterCancel.messages.length, 2)
    assert.equal(afterCancel.messages[1].status, 'cancelled')
    assert.match(afterCancel.messages[1].content[0].text, /partial/u)
    assert.equal(events.some(event => event.type === 'done' && event.cancelled === true), true)

    ctx.setMode('text')
    await ctx.service.retry(chat.id, 's1', () => {})
    const afterRetry = await ctx.service.get(chat.id, 's1')
    assert.equal(afterRetry.messages.length, 2)
    assert.equal(afterRetry.messages.filter(message => message.role === 'user').length, 1)
    assert.equal(afterRetry.messages[1].status, 'done')
    assert.equal(afterRetry.messages[1].content[0].text, 'answer text')
  } finally {
    await ctx.cleanup()
  }
})

test('a failed answer is retried without adding a second user turn', async () => {
  const ctx = await context()
  try {
    const chat = await ctx.service.create({ parentSessionId: 's1', quote: { exact: 'alpha answer' } })
    ctx.setMode('error')
    await ctx.service.turn(chat.id, 's1', 'will fail', () => {})
    let detail = await ctx.service.get(chat.id, 's1')
    assert.equal(detail.status, 'error')
    assert.equal(detail.messages.length, 2)
    assert.equal(detail.messages[1].status, 'error')

    ctx.setMode('text')
    await ctx.service.retry(chat.id, 's1', () => {})
    detail = await ctx.service.get(chat.id, 's1')
    assert.equal(detail.status, 'idle')
    assert.equal(detail.messages.length, 2)
    assert.equal(detail.messages.filter(message => message.role === 'user').length, 1)
    assert.equal(detail.messages[1].status, 'done')
  } finally {
    await ctx.cleanup()
  }
})

test('both side chats can stream independently', async () => {
  const ctx = await context()
  try {
    const first = await ctx.service.create({ parentSessionId: 's1', quote: { exact: 'alpha answer' } })
    const second = await ctx.service.create({ parentSessionId: 's1', quote: { exact: 'beta answer' } })
    await Promise.all([
      ctx.service.turn(first.id, 's1', 'first question', () => {}),
      ctx.service.turn(second.id, 's1', 'second question', () => {}),
    ])
    assert.equal((await ctx.service.get(first.id, 's1')).messages.length, 2)
    assert.equal((await ctx.service.get(second.id, 's1')).messages.length, 2)
    assert.equal(ctx.calls.length, 2)
  } finally {
    await ctx.cleanup()
  }
})
