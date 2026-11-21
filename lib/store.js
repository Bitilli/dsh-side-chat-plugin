/**
 * Durable JSON store for side chats.
 *
 * The store is deliberately independent of the Session log: side chats must
 * survive a Host restart without becoming model-visible sessions in the main
 * conversation list. Writes are serialized and atomic; a corrupt file is moved
 * aside instead of blocking startup.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const FORMAT_VERSION = 1

function emptyState() {
  return { version: FORMAT_VERSION, chats: {} }
}

/** One JSON document with serialized, atomic writes. */
export class SideChatStore {
  /**
   * @param {{ dir: string, file?: string, now?: () => number }} options - storage location.
   */
  constructor({ dir, file = 'side-chats.json', now = () => Date.now() }) {
    this.dir = dir
    this.file = path.join(dir, file)
    this.now = now
    this.state = emptyState()
    this.loaded = false
    this.loading = null
    this.queue = Promise.resolve()
  }

  /** Load the document once. Concurrent callers share the same promise. */
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
      if (parsed === null || typeof parsed !== 'object' || parsed.chats === null
        || typeof parsed.chats !== 'object' || Array.isArray(parsed.chats)) {
        throw new Error('side-chat store has an unexpected shape')
      }
      const chats = {}
      for (const [id, chat] of Object.entries(parsed.chats)) {
        if (chat !== null && typeof chat === 'object' && chat.id === id) chats[id] = chat
      }
      this.state = { version: FORMAT_VERSION, chats }
      this.loaded = true
      return this
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.loaded = true
        return this
      }
      // Preserve the unreadable document for diagnosis, then start clean.
      try {
        await fs.rename(this.file, `${this.file}.corrupt-${this.now()}`)
      } catch {
        // A rename failure must not prevent the plugin from starting.
      }
      this.state = emptyState()
      this.loaded = true
      return this
    }
  }

  /** @returns {object[]} chats for one parent Session, newest last. */
  list(parentSessionId) {
    return Object.values(this.state.chats)
      .filter(chat => parentSessionId === undefined || chat.parentSessionId === parentSessionId)
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
  }

  /** @returns {object | undefined} one stored chat. */
  get(id) {
    return this.state.chats[id]
  }

  /** Insert or replace one chat and persist immediately. */
  async put(chat) {
    this.state.chats[chat.id] = chat
    await this.#persist()
    return chat
  }

  /** Remove one chat and persist immediately. */
  async delete(id) {
    if (this.state.chats[id] === undefined) return false
    delete this.state.chats[id]
    await this.#persist()
    return true
  }

  /** Wait for every queued write. */
  async flush() {
    await this.queue
  }

  #persist() {
    const snapshot = JSON.stringify(this.state)
    const file = this.file
    const previous = this.queue.catch(() => {
      // A failed write must not poison every later write; the next call starts
      // from a settled promise and retries the whole document.
    })
    this.queue = previous.then(async () => {
      await fs.mkdir(this.dir, { recursive: true })
      const temporary = `${file}.${process.pid}.tmp`
      await fs.writeFile(temporary, snapshot, 'utf8')
      await fs.rename(temporary, file)
    })
    return this.queue
  }
}
