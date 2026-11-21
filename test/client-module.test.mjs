import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * Loads the browser module with stub host globals and asserts that `apply`
 * performs the registrations the sidebar and composer seats expect. React
 * components are not rendered here; that remains a browser check.
 */
test('client module registers the selection bridge and sidebar page', async () => {
  const registrations = []
  const tabs = []
  const effects = []
  let loaded
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        loaded = definition
      },
    },
  }
  const react = {
    createElement: () => null,
    Fragment: Symbol('fragment'),
    useCallback: fn => fn,
    useEffect: () => {},
    useMemo: fn => fn(),
    useRef: value => ({ current: value }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
  }
  const document = {
    head: { appendChild() {} },
    body: { setAttribute() {}, removeAttribute() {} },
    createElement() {
      return { dataset: {}, textContent: '', remove() {} }
    },
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
  assert.deepEqual(exports.inject, ['slots', 'locale', 'sessions', 'uiConversation', 'sidebarRight', 'sidebarRightTabs'])

  const ctx = {
    locale: {
      bind: () => key => key,
      register: () => () => {},
    },
    effect: (callback) => {
      const disposer = callback()
      effects.push(disposer)
      return typeof disposer === 'function' ? disposer : () => {}
    },
    slots: {
      inject: (name, callback) => {
        callback()
        return () => {}
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    sidebarRightTabs: {
      register: (definition) => {
        tabs.push(definition)
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  assert.equal(registrations.length, 2)
  assert.equal(registrations[0].options.name, 'conversation.composer.dock')
  assert.equal(registrations[0].options.id, 'side-chat-selection')
  assert.equal(registrations[0].options.locale, 'sideChat')
  assert.equal(typeof registrations[0].component, 'function')
  assert.equal(registrations[1].options.name, 'sidebar.right.pane.tab')
  assert.equal(registrations[1].options.key, 'dsh-side-chat-plugin')
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].kind, 'side-chat')
  assert.equal(tabs[0].keepMounted, true)
  assert.equal(tabs[0].guide[0].id, 'side-chats')
  assert.equal(effects.length, 4)
  delete globalThis.window
  delete globalThis.document
})
