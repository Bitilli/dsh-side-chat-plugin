/**
 * Tiny durable registry of ephemeral side-chat sessions.
 *
 * Only identities and display metadata live here — never conversation text.
 * The registry is what lets the Host purge a side chat after a crash or a
 * normal exit: the actual transcript lives in the Session log and is deleted
 * separately.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const VERSION = 1

function empty() {
  return { version: VERSION, sessions: {} }
}

export class EphemeralRegistry {
  constructor({ dir, file = 'ephemeral.json', now = () => Date.now() }) {
    this.dir = dir
    this.file = path.join(dir, file)
    this.now = now
    this.state = empty()
    this.loaded = false
    this.loading = null
    this.queue = Promise.resolve()
  }

  async load() {
    if (this.loaded) return this
    if (this.loading === null) this.loading = this.#load()
    return this.loading
  }

  async #load() {
    await fs.mkdir(this.dir, { recursive: true })
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || parsed.sessions === null
        || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions)) {
        throw new Error('side-chat registry has an unexpected shape')
      }
      const sessions = {}
      for (const [id, entry] of Object.entries(parsed.sessions)) {
        if (entry !== null && typeof entry === 'object' && entry.sessionId === id) sessions[id] = entry
      }
      this.state = { version: VERSION, sessions }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        try {
          await fs.rename(this.file, `${this.file}.corrupt-${this.now()}`)
        } catch {
          // Starting clean is more important than keeping the unreadable file.
        }
      }
      this.state = empty()
    }
    this.loaded = true
    return this
  }

  list(parentSessionId) {
    return Object.values(this.state.sessions)
      .filter(entry => parentSessionId === undefined || entry.parentSessionId === parentSessionId)
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
  }

  get(sessionId) {
    return this.state.sessions[sessionId]
  }

  async put(entry) {
    this.state.sessions[entry.sessionId] = entry
    await this.#persist()
    return entry
  }

  async remove(sessionId) {
    if (this.state.sessions[sessionId] === undefined) return false
    delete this.state.sessions[sessionId]
    await this.#persist()
    return true
  }

  async clear() {
    this.state = empty()
    await this.#persist()
  }

  async flush() {
    await this.queue
  }

  #persist() {
    const snapshot = JSON.stringify(this.state)
    const file = this.file
    const previous = this.queue.catch(() => {})
    this.queue = previous.then(async () => {
      await fs.mkdir(this.dir, { recursive: true })
      const temporary = `${file}.${process.pid}.tmp`
      await fs.writeFile(temporary, snapshot, 'utf8')
      await fs.rename(temporary, file)
    })
    return this.queue
  }
}
