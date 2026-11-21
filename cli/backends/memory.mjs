// The memory backend: a project's tree with revisions and its ordered log with actors, held in
// memory with no filesystem (cli/backend.mjs has the interface). It's the hosted design's logic
// without the database or the bucket: an entry per file or folder with an id that follows it through
// renames and a revision that rises on every write, versions `<entry id>:<rev>`, a rename as one step
// over the entries, and the log as the feed. History lasts for the backend's lifetime. Only Nebula
// writes here, so every change has its actor. The database backend takes the same shape.
import { randomBytes } from 'node:crypto'
import {
  BackendError,
  ID_PATTERN,
  META_PATH,
  PLANETS,
  changeRecord,
  checkMeta,
  hasProjectId,
  isInside,
  newProjectId,
  projectInfoOf,
  recentPage,
  refuseOwnMove,
  refuseOwnRemove,
  servedSegments,
} from '../backend.mjs'

/** How much of a file one chunk of a read carries. */
const CHUNK = 64 * 1024
const decoder = new TextDecoder()
const encoder = new TextEncoder()

const nameOf = (path) => path.slice(path.lastIndexOf('/') + 1)
const parentsOf = (path) => {
  const parts = path.split('/')
  return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join('/'))
}

/**
 * The memory backend. `createdBy` names who a project made with no actor is created by.
 * @returns {import('../backend.mjs').ProjectBackend}
 */
export function createMemoryBackend({ createdBy = 'nebula-server' } = {}) {
  const epoch = randomBytes(6).toString('hex')
  /** id → { id, index, epoch, seq, entries: Map<path, Entry>, log, subscribers } */
  const projects = new Map()
  /** The backend's log across projects, for `recent`: { order, record }. */
  const history = []
  let entryCount = 0
  let order = 0

  /** A new entry: its id is the backend's, never reused in its lifetime. A file holds its bytes. */
  function newEntry(type, bytes, actor) {
    entryCount += 1
    const entry = { id: entryCount.toString(36), type, rev: 1, modified: Date.now() }
    if (type === 'file') Object.assign(entry, { bytes, modifiedBy: actor })
    return entry
  }

  const versionOf = (entry) => `${entry.id}:${entry.rev}`

  function entryOf(path, entry) {
    if (entry.type === 'dir') return { path, name: nameOf(path), type: 'dir' }
    const shown = { path, name: nameOf(path), type: 'file', size: entry.bytes.byteLength, modified: entry.modified }
    if (entry.modifiedBy) shown.modifiedBy = entry.modifiedBy
    return shown
  }

  function spaceOf(id) {
    const space = projects.get(id)
    if (!space) throw new BackendError('no-project', `No project ${JSON.stringify(id)} here`)
    return space
  }

  /** The project's info from its own `.nebula/project.json`, whatever has been written there. */
  function infoOf(space) {
    let meta = {}
    const file = space.entries.get(META_PATH)
    if (file?.type === 'file') {
      try {
        meta = JSON.parse(decoder.decode(file.bytes))
      } catch {
        meta = {}
      }
    }
    return projectInfoOf({ ...meta, id: space.id }, { name: space.id, color: PLANETS[space.index % PLANETS.length], createdBy })
  }

  /** Where a path stands: a file on the way (`blocked`), or the first missing folder on the way (`missing`). */
  function standing(space, segments) {
    for (const parent of parentsOf(segments.join('/'))) {
      const entry = space.entries.get(parent)
      if (!entry) return { missing: true }
      if (entry.type !== 'dir') return { blocked: true }
    }
    return {}
  }

  function makeParents(space, path) {
    for (const parent of parentsOf(path)) if (!space.entries.has(parent)) space.entries.set(parent, newEntry('dir'))
  }

  function emit(space, change, author = {}) {
    space.seq += 1
    const cursor = `${space.epoch}:${space.seq}`
    const record = changeRecord({ seq: space.seq, cursor, project: space.id, change, actor: author.actor, context: author.context, client: author.client })
    space.log.push(record)
    order += 1
    history.push({ order, record })
    for (const subscriber of space.subscribers) subscriber.change(record)
    return cursor
  }

  const cursorOf = (space) => `${space.epoch}:${space.seq}`

  async function bytesOf(body) {
    const chunks = []
    let size = 0
    for await (const chunk of body) {
      chunks.push(chunk)
      size += chunk.byteLength
    }
    const bytes = new Uint8Array(size)
    let at = 0
    for (const chunk of chunks) {
      bytes.set(chunk, at)
      at += chunk.byteLength
    }
    return bytes
  }

  async function createProject({ id, name, color } = {}, { actor } = {}) {
    if (id !== undefined && (!hasProjectId({ id }) || !ID_PATTERN.test(id))) throw new BackendError('invalid-path', `${JSON.stringify(id)} isn't a project id`)
    if (id !== undefined && projects.has(id)) throw new BackendError('exists', `A project ${JSON.stringify(id)} is here already`)
    id ??= newProjectId(randomBytes)
    const index = projects.size
    const meta = {
      id,
      name: typeof name === 'string' && name.trim() ? name : id,
      color: color ?? PLANETS[index % PLANETS.length],
      created: new Date().toISOString(),
      createdBy: actor?.id ?? createdBy,
    }
    const space = { id, index, epoch: `${epoch}.${randomBytes(3).toString('hex')}`, seq: 0, entries: new Map(), log: [], subscribers: new Set() }
    // The project's identity lives in its own tree, as in every other place it can be.
    space.entries.set('.nebula', newEntry('dir'))
    space.entries.set(META_PATH, newEntry('file', encoder.encode(`${JSON.stringify(meta, null, 2)}\n`), actor))
    projects.set(id, space)
    return infoOf(space)
  }

  async function write(id, path, body, { ifMatch, ifAbsent = false, parents = true, ...author } = {}) {
    const space = spaceOf(id)
    const segments = servedSegments(path)
    const bytes = await bytesOf(body)
    if (path === META_PATH) checkMeta(decoder.decode(bytes), bytes.byteLength, id)
    // From here to the record, nothing waits: the check and the write are one step.
    const at = standing(space, segments)
    if (at.blocked) throw new BackendError('type', `${JSON.stringify(path)} goes through a file`, { expected: 'folder' })
    if (at.missing && !parents) throw new BackendError('not-found', `The folder for ${JSON.stringify(path)} is gone`)
    const existing = space.entries.get(path)
    if (ifAbsent) {
      if (existing) throw new BackendError('precondition', `Something already exists at ${JSON.stringify(path)}`, { exists: true })
    } else if (ifMatch) {
      if (!existing || existing.type !== 'file') throw new BackendError('precondition', `${JSON.stringify(path)} is gone, or isn't a file`, { absent: true })
      if (versionOf(existing) !== ifMatch) throw new BackendError('precondition', `${JSON.stringify(path)} changed`, { absent: false })
    }
    if (existing && existing.type !== 'file') throw new BackendError('type', `${JSON.stringify(path)} is a folder`, { expected: 'file' })
    makeParents(space, path)
    let entry
    if (existing) {
      // The same file, a new revision: a reader holding the old bytes keeps them whole.
      entry = { ...existing, bytes, rev: existing.rev + 1, modified: Date.now(), modifiedBy: author.actor }
      if (!author.actor) delete entry.modifiedBy
    } else entry = newEntry('file', bytes, author.actor)
    space.entries.set(path, entry)
    const cursor = emit(space, { type: 'write', path }, author)
    return { entry: entryOf(path, entry), version: versionOf(entry), cursor }
  }

  async function makeDir(id, path, author = {}) {
    const space = spaceOf(id)
    const segments = servedSegments(path)
    const at = standing(space, segments)
    if (at.blocked) throw new BackendError('type', `${JSON.stringify(path)} goes through a file`, { expected: 'folder' })
    const existing = space.entries.get(path)
    if (existing) {
      if (existing.type !== 'dir') throw new BackendError('type', `${JSON.stringify(path)} is a file`, { expected: 'folder' })
      return { changed: false, cursor: cursorOf(space) }
    }
    makeParents(space, path)
    space.entries.set(path, newEntry('dir'))
    return { changed: true, cursor: emit(space, { type: 'mkdir', path }, author) }
  }

  async function move(id, from, to, author = {}) {
    const space = spaceOf(id)
    servedSegments(from)
    const toSegments = servedSegments(to)
    refuseOwnMove(from, to)
    if (!space.entries.has(from) || standing(space, from.split('/')).blocked) throw new BackendError('not-found', `Nothing exists at ${JSON.stringify(from)}`)
    if (space.entries.has(to) || from === to) throw new BackendError('exists', `Something already exists at ${JSON.stringify(to)}`)
    if (standing(space, toSegments).blocked) throw new BackendError('type', `${JSON.stringify(to)} goes through a file`, { expected: 'folder' })
    if (isInside(to, from)) throw new BackendError('into-itself', `A folder can't move into itself`)
    // One step over the entries: each keeps its id and revision, so its version follows it.
    const moved = [...space.entries].filter(([path]) => isInside(path, from))
    for (const [path] of moved) space.entries.delete(path)
    makeParents(space, to)
    for (const [path, entry] of moved) space.entries.set(to + path.slice(from.length), entry)
    return { cursor: emit(space, { type: 'rename', from, to }, author) }
  }

  async function remove(id, path, author = {}) {
    const space = spaceOf(id)
    servedSegments(path)
    refuseOwnRemove(path)
    if (!space.entries.has(path) || standing(space, path.split('/')).blocked) throw new BackendError('not-found', `Nothing exists at ${JSON.stringify(path)}`)
    for (const known of [...space.entries.keys()]) if (isInside(known, path)) space.entries.delete(known)
    return { cursor: emit(space, { type: 'remove', path }, author) }
  }

  async function read(id, path) {
    const space = spaceOf(id)
    servedSegments(path)
    const entry = space.entries.get(path)
    if (!entry) throw new BackendError('not-found', `Nothing exists at ${JSON.stringify(path)}`)
    if (entry.type !== 'file') throw new BackendError('type', `${JSON.stringify(path)} is a folder`, { expected: 'file' })
    // The bytes are this revision's and never change, so the stream is the file as it was now.
    const { bytes } = entry
    let at = 0
    const body = new ReadableStream({
      pull(controller) {
        if (at >= bytes.byteLength) return controller.close()
        controller.enqueue(bytes.slice(at, at + CHUNK))
        at += CHUNK
      },
    })
    return { body, size: bytes.byteLength, version: versionOf(entry), entry: entryOf(path, entry) }
  }

  return {
    capabilities: { otherWriters: false, durableHistory: false, createProject: true, versions: false, removeProject: false },
    createProject,
    async listProjects() {
      return [...projects.values()].map(infoOf)
    },
    async project(id) {
      return infoOf(spaceOf(id))
    },
    async cursor(id) {
      return cursorOf(spaceOf(id))
    },
    async list(id) {
      const space = spaceOf(id)
      return [...space.entries]
        .filter(([path]) => !isInside(path, '.nebula'))
        .map(([path, entry]) => (entry.type === 'file' ? { ...entryOf(path, entry), version: versionOf(entry) } : entryOf(path, entry)))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    },
    async stat(id, path) {
      const space = spaceOf(id)
      servedSegments(path)
      const entry = space.entries.get(path)
      if (!entry) return null
      return { entry: entryOf(path, entry), version: entry.type === 'file' ? versionOf(entry) : null }
    },
    read,
    write,
    mkdir: makeDir,
    rename: move,
    remove,
    async changesSince(id, since) {
      const space = spaceOf(id)
      const [sinceEpoch, sinceSeq] = String(since ?? '').split(':')
      const seq = Number(sinceSeq)
      if (sinceEpoch !== space.epoch || !Number.isInteger(seq) || seq < 0 || seq > space.seq) return { cursor: cursorOf(space), resync: true }
      return { cursor: cursorOf(space), changes: space.log.filter((record) => record.seq > seq) }
    },
    async subscribe(id, subscriber) {
      const space = spaceOf(id)
      space.subscribers.add(subscriber)
      return () => void space.subscribers.delete(subscriber)
    },
    async recent(query = {}) {
      return recentPage(history, query)
    },
    /** The files in one project's tree (`.nebula/`'s included), or in all, and their bytes. */
    async usage(id) {
      const usage = { bytes: 0, files: 0 }
      for (const space of id === undefined ? projects.values() : [spaceOf(id)]) {
        for (const entry of space.entries.values()) {
          if (entry.type !== 'file') continue
          usage.files += 1
          usage.bytes += entry.bytes.byteLength
        }
      }
      return usage
    },
    close() {
      for (const space of projects.values()) {
        for (const subscriber of space.subscribers) subscriber.end()
        space.subscribers.clear()
      }
    },
  }
}
