import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildRequestMessages, buildSystemPrompt, deriveParentTitle, freezeSnapshot,
  heuristicTokens, locateAnchor, normalizeText, parentMessages, publicChat,
} from '../lib/core.js'

function message(id, role, text) {
  return { id, role, content: [{ type: 'text', text }], source: { kind: role === 'user' ? 'user' : 'model', provider: 'p', model: 'm' } }
}

function session(rows) {
  const messages = rows.map(row => message(row.id, row.role, row.text))
  return {
    id: 's1',
    deriveMessages: () => messages,
    surface: { nodes: [] },
    eventAt: () => undefined,
  }
}

const rows = [
  { id: 'm1', role: 'user', text: 'first question about alpha' },
  { id: 'm2', role: 'assistant', text: 'first answer about alpha' },
  { id: 'm3', role: 'user', text: 'later question about beta' },
  { id: 'm4', role: 'assistant', text: 'later answer about beta' },
]

test('parentMessages keeps only user and assistant text in order', () => {
  const result = parentMessages(session(rows))
  assert.deepEqual(result.map(row => row.id), ['m1', 'm2', 'm3', 'm4'])
  assert.equal(result[1].text, 'first answer about alpha')
})

test('locateAnchor prefers the explicit message id', () => {
  const located = locateAnchor(rows, { messageId: 'm2', exact: 'alpha' })
  assert.equal(located.index, 1)
  assert.equal(located.match, 'id')
})

test('locateAnchor falls back to exact text when the id is stale', () => {
  const located = locateAnchor(rows, { messageId: 'm-deleted', exact: 'first answer about alpha' })
  assert.equal(located.index, 1)
  assert.equal(located.match, 'exact')
})

test('locateAnchor uses prefix and suffix when only those survive', () => {
  const located = locateAnchor(rows, { messageId: 'm-deleted', exact: 'not present', prefix: 'first answer', suffix: 'alpha' })
  assert.equal(located.index, 1)
  assert.equal(located.match, 'affix')
})

test('locateAnchor degrades to the newest message instead of failing', () => {
  const located = locateAnchor(rows, { messageId: 'm-deleted', exact: 'text that is gone' })
  assert.equal(located.index, rows.length - 1)
  assert.equal(located.match, 'none')
})

test('freezeSnapshot stops at the anchor and trims from the front', () => {
  const frozen = freezeSnapshot(rows, 2, { maxTokens: 8, estimate: row => Math.ceil(row.text.length / 2) })
  assert.equal(frozen.messages.at(-1).id, 'm3')
  assert.equal(frozen.messages.some(row => row.id === 'm4'), false)
  assert.ok(frozen.truncatedCount > 0)
  assert.equal(frozen.excludedAfterAnchor, 1)
})

test('freezeSnapshot always keeps the anchor even over budget', () => {
  const frozen = freezeSnapshot(rows, 1, { maxTokens: 1, estimate: () => 100 })
  assert.deepEqual(frozen.messages.map(row => row.id), ['m2'])
  assert.equal(frozen.estimatedTokens, 100)
})

test('buildSystemPrompt freezes the snapshot and quote', () => {
  const chat = {
    parentTitle: 'Alpha',
    parentSessionId: 's1',
    anchorMessageId: 'm2',
    anchorSeq: 12,
    quoteRef: { exact: 'first answer about alpha' },
    contextSnapshot: {
      capturedAt: '2026-01-01T00:00:00.000Z',
      estimatedTokens: 42,
      truncatedCount: 1,
      strategy: 'tail-budget',
      messages: [{ role: 'user', text: 'first question about alpha' }],
    },
  }
  const prompt = buildSystemPrompt(chat)
  assert.match(prompt, /first answer about alpha/u)
  assert.match(prompt, /read-only snapshot/u)
  assert.match(prompt, /truncated 1 earlier messages|1 earlier messages omitted/u)
  assert.match(prompt, /Anchor message: m2 at seq 12/u)
})

test('buildRequestMessages excludes failed assistants and keeps user text', () => {
  const chat = {
    messages: [
      { id: 'u1', role: 'user', content: [{ type: 'text', text: 'q1' }], status: 'done' },
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'bad' }], status: 'error' },
      { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'good' }], status: 'done' },
    ],
  }
  const messages = buildRequestMessages(chat, { provider: 'p', model: 'm' })
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[1].content[0].text, 'good')
  assert.deepEqual(messages[1].source, { kind: 'model', provider: 'p', model: 'm' })
})

test('titles and helpers stay deterministic', () => {
  assert.equal(normalizeText('  a\n b  '), 'a b')
  assert.equal(deriveParentTitle(rows), 'first question about alpha')
  assert.equal(heuristicTokens('abcd'), 1)
  assert.equal(heuristicTokens('abcde'), 2)
  const chat = {
    id: 's', kind: 'side', parentSessionId: 's1', parentTitle: 't', anchorMessageId: '', anchorSeq: null,
    contextSnapshotId: 'c', title: 't', status: 'idle', createdAt: 'x', updatedAt: 'x', quoteRef: { exact: 'e' },
    contextSnapshot: { messages: [] }, messages: [],
  }
  assert.equal(publicChat(chat).id, 's')
})
