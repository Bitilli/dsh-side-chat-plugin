/**
 * Host half of the Side chat plugin.
 *
 * A side chat is an ephemeral fork of the parent Session with a live Agent, so
 * the native Conversation in the sidebar gets the same files, tools, skills,
 * model API, reasoning effort and permission presets as the main chat.
 */
import os from 'node:os'
import path from 'node:path'
import { rm, stat, rmdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { NativeSideChatManager } from './lib/manager.js'
import { EphemeralRegistry } from './lib/registry.js'
import { createSideChatFetchRoutes } from './lib/http.js'

export const name = 'side-chat'

export const inject = ['sessions', 'agents', 'connection', 'sessionPersistence', 'sessionQuery']

function storageDirectory() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const profile = process.env.DSH_PROFILE
  return path.join(home, 'side-chat', typeof profile === 'string' && profile !== '' ? profile : 'default')
}

/**
 * Resolve a package shipped with this DSH installation from the CLI anchor.
 * A profile-linked bundle does not inherit the installation's node_modules, so
 * bare imports of shipped packages are resolved through DSH_INSTALL_DIR.
 */
function installRequire() {
  const installDir = process.env.DSH_INSTALL_DIR
    ?? path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh')
  return createRequire(path.join(installDir, 'package.json'))
}

function loadForkSeed() {
  const requireFromInstall = installRequire()
  const resolved = requireFromInstall.resolve('@deepseek-ai/dsh-session/fork')
  return import(pathToFileURL(resolved).href).then(module => module.buildForkSeed)
}

/**
 * Plugin entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 */
export function apply(ctx) {
  const registry = new EphemeralRegistry({ dir: storageDirectory() })
  const forkSeed = loadForkSeed().catch((error) => {
    console.error('[side-chat] cannot load the session fork builder', error)
    return undefined
  })
  const permissionPresets = ctx.get('permissionPresets')
  const agentPresets = ctx.get('agentPresets')
  const defaultModel = ctx.get('agentDefaultModel')

  const manager = new NativeSideChatManager({
    registry,
    createAgent: options => ctx.agents.create(options),
    getSession: id => ctx.sessions.get(id),
    getAgent: id => ctx.agents.get(id),
    statSession: id => ctx.sessionPersistence.stat(id),
    readSessionLog: id => ctx.sessionQuery.readSession(id),
    removePath: async (target) => {
      let info
      try {
        info = await stat(target)
      } catch {
        return
      }
      await rm(target, { recursive: true, force: true })
      if (info.isFile()) {
        // The JSONL backend stores one session in its own directory. Remove the
        // now-empty session directory so a closed side chat leaves no shell.
        try {
          await rmdir(path.dirname(target))
        } catch {
          // A shared or non-empty directory is left untouched.
        }
      }
    },
    buildSeed: async (events, boundary) => {
      const buildForkSeed = await forkSeed
      if (buildForkSeed === undefined) throw new Error('the session fork builder is unavailable')
      return buildForkSeed(events, boundary)
    },
    defaultSelection: () => defaultModel?.currentSelection(),
    permissionCurrent: session => permissionPresets?.current(session),
    permissionSet: (session, preset) => permissionPresets?.set(session, preset),
    agentPreset: session => agentPresets?.presetForSession(session),
    logger: (message, error) => console.error(`[side-chat] ${message}`, error),
  })

  const ready = manager.ready()
    .then(() => manager.purgeStale())
    .catch(error => {
      console.error('[side-chat] startup cleanup failed', error)
    })

  const routes = createSideChatFetchRoutes({ manager })
  ctx.effect(() => {
    const disposers = []
    for (const route of routes) {
      try {
        disposers.push(ctx.connection.fetch.register(route))
      } catch (error) {
        console.error(`[side-chat] route ${route.path} was not registered`, error)
      }
    }
    return () => {
      for (const dispose of disposers) void dispose()
    }
  }, 'side-chat: fetch routes')

  ctx.effect(() => () => {
    // Best-effort exit cleanup. A hard kill leaves registry rows for the next
    // startup purge; conversation text lives only in the deleted Session logs.
    void ready.then(() => manager.disposeAll())
  }, 'side-chat: purge on unload')
}
