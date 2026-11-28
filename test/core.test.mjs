import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveParentTitle, locateAnchor, normalizeText, parentMessages, parseSideChatAddress,
  quoteMessage, resolveAnchor, sideChatAddress, titleFromQuote,
} from '../lib/core.js'

function message(id, role, text) {
  return { id, role, content: [{ type: 'text', text }], source: { kind: role === 'user' ? 'user' : 'model', provider: 'p', model: 'm' } }
}

function session(rows) {
  const messages = rows.map(row => message(row.id, row.role, row.text))
  const seqOf = new Map(rows.map(row => [row.id, row.seq]))
  return {
    id: 's1',
    header: { cwd: 'D:/work' },
    deriveMessages: () => messages,
    surface: { nodes: rows.map(row => row.seq) },
    eventAt: seq => {
      const row = rows.find(candidate => candidate.seq === seq)
      if (row === undefined) return undefined
      return row.role === 'user'
        ? { type: 'user/message', data: { id: row.id } }
        : { type: 'assistant/message', data: { message: { id: row.id } } }
    },
  }
}

const rows = [
  { id: 'm1', role: 'user', text: 'first question about alpha', seq: 3 },
  { id: 'm2', role: 'assistant', text: 'first answer about alpha', seq: 8 },
  { id: 'm3', role: 'user', text: 'later question about beta', seq: 12 },
  { id: 'm4', role: 'assistant', text: 'later answer about beta', seq: 18 },
]

test('parent messages keep surface seqs and text', () => {
  const result = parentMessages(session(rows))
  assert.deepEqual(result.map(row => [row.id, row.seq]), [['m1', 3], ['m2', 8], ['m3', 12], ['m4', 18]])
  assert.equal(result[1].text, 'first answer about alpha')
})

test('anchor prefers the explicit message id, then exact text, then affixes', () => {
  assert.equal(locateAnchor(rows, { messageId: 'm2', exact: 'alpha' }).match, 'id')
  assert.equal(locateAnchor(rows, { messageId: 'gone', exact: 'first answer about alpha' }).index, 1)
  assert.equal(locateAnchor(rows, { exact: 'gone', prefix: 'first answer', suffix: 'alpha' }).index, 1)
  assert.equal(locateAnchor(rows, { exact: 'gone' }).match, 'none')
})

test('resolveAnchor returns the surface seq used as the fork boundary', () => {
  assert.deepEqual(resolveAnchor(session(rows), { exact: 'first answer about alpha' }), {
    boundary: 8, anchorMessageId: 'm2', match: 'exact',
  })
  assert.deepEqual(resolveAnchor(session(rows), { exact: 'gone' }), {
    boundary: 18, anchorMessageId: 'm4', match: 'none',
  })
  assert.deepEqual(resolveAnchor({ surface: { nodes: [] }, deriveMessages: () => [], eventAt: () => undefined }, {}), {
    boundary: -1, anchorMessageId: '', match: 'none',
  })
})

test('titles and quote messages are derived from the selection', () => {
  assert.equal(deriveParentTitle(rows), 'first question about alpha')
  assert.match(titleFromQuote({ exact: 'alpha answer' }), /^侧聊 · alpha answer$/u)
  const text = quoteMessage({
    parentTitle: 'Alpha', anchorMessageId: 'm2', exact: 'alpha answer', prefix: 'first ', suffix: ' about alpha',
  })
  assert.match(text, /父对话：Alpha/u)
  assert.match(text, /锚点消息：m2/u)
  assert.match(text, /alpha answer/u)
  assert.match(text, /请围绕这段引用/u)
})

test('side-chat resource addresses round-trip', () => {
  const address = sideChatAddress({ childSessionId: 'side-1', parentSessionId: 's1', title: '侧聊 · quote' })
  assert.match(address, /^dsh-resource:\/\/sidechat\/session\//u)
  assert.deepEqual(parseSideChatAddress(address), {
    childSessionId: 'side-1', parentSessionId: 's1', title: '侧聊 · quote',
  })
  assert.equal(parseSideChatAddress('dsh-resource://subagentchat/session/x?parent=s1&mode=continuable'), undefined)
  assert.equal(parseSideChatAddress('nope'), undefined)
  assert.equal(normalizeText(' a\n b '), 'a b')
})
