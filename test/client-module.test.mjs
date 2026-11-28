import assert from 'node:assert/strict'
import test from 'node:test'

test('client module registers the bar, resource provider and native sidebar tab', async () => {
  const registrations = []
  const tabs = []
  const resources = []
  const closeHandlers = []
  const effects = []
  let loaded
  globalThis.window = { __ModuleLoader__: { load(definition) { loaded = definition } } }
  const react = {
    createElement: () => null,
    Fragment: Symbol('fragment'),
    useCallback: fn => fn,
    useEffect: () => {},
    useRef: value => ({ current: value }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
  }
  const document = {
    head: { appendChild() {} },
    body: { setAttribute() {}, removeAttribute() {} },
    createElement() { return { dataset: {}, textContent: '', remove() {} } },
    getSelection: () => null,
    addEventListener() {},
    removeEventListener() {},
  }
  globalThis.document = document
  const require = name => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: () => null }
    throw new Error(`unexpected require ${name}`)
  }

  await import('../client.js')
  assert.equal(loaded.id, 'dsh-side-chat-plugin')
  const exports = loaded.factory(require)
  assert.equal(exports.name, 'side-chat')
  assert.deepEqual(exports.inject, ['slots', 'locale', 'sessions', 'sidebarRight', 'sidebarRightTabs', 'resources'])

  const openTabs = { getSnapshot: () => [] }
  const ctx = {
    locale: { bind: () => key => key, register: () => () => {} },
    effect: (callback) => {
      const disposer = callback()
      effects.push(disposer)
      return typeof disposer === 'function' ? disposer : () => {}
    },
    slots: {
      inject: (name, callback) => { callback(); return () => {} },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    resources: {
      register: (provider) => { resources.push(provider); return () => {} },
    },
    sidebarRightTabs: {
      register: (definition) => { tabs.push(definition); return () => {} },
    },
    sidebarRight: {
      openTabs,
      close: () => {},
      registerCloseHandler: (kind, handler) => {
        closeHandlers.push({ kind, handler })
        return () => {}
      },
    },
    sessions: {
      retain: () => ({ release: () => {} }),
    },
  }
  exports.apply(ctx)

  assert.equal(registrations.length, 2)
  assert.equal(registrations[0].options.name, 'conversation.composer.dock')
  assert.equal(registrations[0].options.id, 'side-chat-selection')
  assert.equal(registrations[1].options.name, 'sidebar.right.pane.tab')
  assert.equal(registrations[1].options.key, 'dsh-side-chat-plugin')
  assert.deepEqual(registrations[1].options.children, {
    'sidebar.chat.conversation': { kind: 'single', scope: 'session' },
  })
  assert.equal(resources.length, 1)
  assert.equal(resources[0].protocol, 'sidechat')
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].kind, 'sidechat')
  assert.equal(tabs[0].keepMounted, true)
  assert.deepEqual(tabs[0].patterns, ['dsh-resource://sidechat/session/**'])
  assert.equal(closeHandlers.length, 1)
  assert.equal(closeHandlers[0].kind, 'sidechat')

  const address = 'dsh-resource://sidechat/session/side-1?parent=s1&title=x'
  assert.equal(tabs[0].canOpen(address), true)
  assert.equal(tabs[0].title(address), 'x')
  assert.equal(tabs[0].canOpen('dsh-resource://file/x'), false)
  assert.ok(effects.length >= 5)
  delete globalThis.window
  delete globalThis.document
})
