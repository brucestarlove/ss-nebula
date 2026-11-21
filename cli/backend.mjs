// The server's backend interface: how Nebula's file API (cli/nebula-files.mjs) stores projects.
// The HTTP layer speaks the same API whatever the backend is: real folders on a person's own server
// (cli/backends/folder.mjs), a tree and log held in memory (cli/backends/memory.mjs), and a
// database for the tree with a byte store for the contents (cli/backends/database.mjs; Starscape
// hosting puts that byte store in object storage). Each method's comment below says what every
// backend guarantees.
//
// Written as JSDoc, since cli/ has no TypeScript build. Node built-ins only, like the rest of cli/.

/**
 * Who made a change. The same `type` words as Orbit's actors (ss-orbit `core/model.ts`), so the
 * Suite can merge both apps' activity into one list.
 * @typedef {{ type: 'human' | 'agent', id: string, name: string }} Actor
 */

/**
 * A project, as `.nebula/project.json` in its own tree says, plus where it is.
 * @typedef {object} ProjectInfo
 * @property {string} id
 * @property {string} name
 * @property {string} color  `#rrggbb`, lower case
 * @property {string} created  ISO time
 * @property {string} createdBy
 * @property {string} [folder]  the folder's name, where the project is one
 * @property {string} [dir]  the folder's absolute path on the host: for the host's own logs, never sent to a client
 */

/**
 * A file or folder. `modified` is milliseconds; `modifiedBy` is who last wrote the file through
 * Nebula, whenever the backend knows it (a folder backend knows only what this run wrote, and forgets
 * it when anyone else writes the file).
 * @typedef {object} Entry
 * @property {string} path
 * @property {string} name
 * @property {'file' | 'dir'} type
 * @property {number} [size]
 * @property {number} [modified]
 * @property {Actor} [modifiedBy]
 * @property {string} [version]  a file's version, in `list` (as `stat` gives it)
 */

/**
 * Who is asking, passed with every change. `actor` is absent only for a change made outside Nebula.
 * `context` is a link the writer names (`orbit:card/<board>/<n>`), stored as given and never
 * interpreted or fetched. `client` is the asking page's id (`Nebula-Client`), carried on the record
 * so that page can skip the echo of its own change.
 * @typedef {object} Author
 * @property {Actor} [actor]
 * @property {string} [context]
 * @property {string} [client]
 */

/**
 * A write's precondition and shape. With neither `ifMatch` nor `ifAbsent` it writes whatever is there.
 * @typedef {Author & {
 *   ifMatch?: string,
 *   ifAbsent?: boolean,
 *   parents?: boolean,
 * }} WriteOptions
 * `ifMatch`: write only over this version (412 `precondition`, `absent` told). `ifAbsent`: create
 * only (412 `precondition`, `exists`). `parents`: whether missing folders on the way may be made
 * (default true); false answers `not-found` when the folder is gone, so a write never brings back a
 * folder someone else removed.
 */

/**
 * One change, in order per project. `cursor` is the project's cursor once this change is in
 * (`<epoch>:<seq>`), the feed's event id.
 * @typedef {object} ChangeRecord
 * @property {number} seq
 * @property {string} cursor
 * @property {string} at  ISO time, with milliseconds
 * @property {string} project
 * @property {'write' | 'mkdir' | 'remove' | 'rename'} type
 * @property {string} [path]  for write, mkdir and remove
 * @property {string} [from]  for rename
 * @property {string} [to]  for rename
 * @property {Actor} [actor]  absent when the change was made outside Nebula
 * @property {string} [context]
 * @property {string} [client]
 * @property {string} [restoredFrom]  on a write that brought back an earlier version (`restore`): that version
 */

/**
 * @typedef {object} ReadResult
 * @property {ReadableStream<Uint8Array>} body  the file as it was at one moment; read it to the end or cancel it, which lets go of what the backend holds open
 * @property {number} size
 * @property {string} version
 * @property {Entry} entry
 */

/**
 * @typedef {{ cursor: string, changes: ChangeRecord[] } | { cursor: string, resync: true }} ChangesSince
 * `resync` when the cursor is another epoch's, ahead, or older than the history kept: the client lists again.
 */

/**
 * A live listener. `end` is called when the project's feed stops for good here (its folder went, or
 * moved and is served from a fresh epoch), so clients reconnect and resync.
 * @typedef {{ change: (record: ChangeRecord) => void, end: () => void }} Subscriber
 */

/**
 * @typedef {object} RecentQuery
 * @property {string} [project]  one project, or all of the backend's
 * @property {string} [path]  a file, or a folder and everything in it (a rename counts at both ends)
 * @property {number} [limit]  at most this many (the HTTP layer caps it)
 * @property {string} [before]  a previous page's `next`
 */

/** @typedef {{ changes: ChangeRecord[], next: string | null }} RecentPage */

/**
 * @typedef {object} Capabilities
 * @property {boolean} otherWriters  programs other than Nebula write the files (a folder: yes), so changes can arrive with no actor and versions can change under Nebula
 * @property {boolean} durableHistory  the change log and its cursors survive a restart (a folder: no; the database backend: yes)
 * @property {boolean} createProject  the backend makes projects itself (`createProject`): memory, database, and folders when there is a `projectsDirs` to make them in
 * @property {boolean} [versions]  the backend keeps earlier versions of each file and can read and restore them (`versions`, `readVersion`, `restore`): the database backend
 * @property {boolean} [removeProject]  a project can be removed and restored within the days history is kept (`removeProject`, `removedProjects`, `restoreProject`): the database backend
 * @property {boolean} [deletedFiles]  the files deleted from a project can be listed while their last version is kept (`deletedFiles`), and restored with `restore`: the database backend
 */

/**
 * One kept version of a file (src/files/serverContract.ts `VersionInfo`). A file keeps its history
 * through renames, so `path` is the path it had when this version was written.
 * @typedef {object} VersionInfo
 * @property {string} version  opaque; the current one's is the file's version (its ETag unquoted)
 * @property {string} at  when it was written: ISO time with milliseconds
 * @property {number} size  bytes
 * @property {Actor} [actor]  who wrote it
 * @property {string} [context]  the link the writer named
 * @property {boolean} current  whether this is the file at the path now
 * @property {string} path
 * @property {string} [restoredFrom]  on a version made by `restore`: the version it brought back
 */

/**
 * A file deleted and still restorable (src/files/history.ts `DeletedFile`): `version` is its last, what `restore` is given.
 * @typedef {object} DeletedFile
 * @property {string} path
 * @property {string} version
 * @property {number} size  bytes
 * @property {string} deletedAt  ISO time
 * @property {Actor} [deletedBy]
 */

/** @typedef {{ versions: VersionInfo[], next: string | null }} VersionsPage  newest first; `next` is the next page's `before`, null at the end */

/**
 * A project removed on purpose (src/files/serverContract.ts `RemovedProject`), restorable until
 * `purgeAfter`, when the sweep purges it.
 * @typedef {object} RemovedProject
 * @property {string} id
 * @property {string} name
 * @property {string} color
 * @property {string} removed  ISO time
 * @property {Actor} [removedBy]
 * @property {string} purgeAfter  ISO time
 */

/** @typedef {{ bytes: number, files: number }} Usage  the files in a project's tree (`.nebula/`'s own included) and their bytes; earlier versions kept for history aren't counted */

/**
 * The interface. Paths follow Nebula's rules (`pathProblem`); a backend refuses what they refuse.
 * Versions are opaque strings the backend makes; the HTTP layer quotes them into ETags. Every
 * method rejects with a `BackendError` for anything a person can be told (the codes below), and any
 * other error is the server's fault (500).
 *
 * @typedef {object} ProjectBackend
 * @property {Capabilities} capabilities
 * @property {(options?: { actor?: Actor }) => Promise<ProjectInfo[]>} listProjects  a fresh look; `actor` is who a project found now is created by
 * @property {(id: string, options?: { actor?: Actor }) => Promise<ProjectInfo>} project  or `no-project`
 * @property {(id: string) => Promise<string>} cursor  the project's change cursor now
 * @property {(id: string) => Promise<Entry[]>} list  every file and folder, except `.nebula/`
 * @property {(id: string, path: string) => Promise<{ entry: Entry, version: string | null } | null>} stat  null when nothing is there; `version` for a file
 * @property {(id: string, path: string) => Promise<ReadResult>} read
 * @property {(id: string, path: string, body: AsyncIterable<Uint8Array>, options?: WriteOptions) => Promise<{ entry: Entry, version: string, cursor: string }>} write  whole-file replacement
 * @property {(id: string, path: string, options?: Author) => Promise<{ changed: boolean, cursor: string }>} mkdir  with its parents; `changed` false when it was there
 * @property {(id: string, from: string, to: string, options?: Author) => Promise<{ cursor: string }>} rename  a file or a folder; refuses an existing target (`exists`) and a folder into itself
 * @property {(id: string, path: string, options?: Author) => Promise<{ cursor: string }>} remove  a file, or a folder and all in it
 * @property {(id: string, cursor: string) => Promise<ChangesSince>} changesSince
 * @property {(id: string, subscriber: Subscriber) => Promise<() => void>} subscribe  live changes from now; returns the function that stops them
 * @property {(query?: RecentQuery) => Promise<RecentPage>} recent  across the backend's projects, newest first
 * @property {(meta: { id?: string, name: string, color?: string }, options?: { actor?: Actor }) => Promise<ProjectInfo>} [createProject]  where `capabilities.createProject` says so; refuses a taken id (`exists`), and the project's `createdBy` is the actor's id
 * @property {(id?: string) => Promise<Usage>} usage  one project's, or the whole backend's
 * @property {(id: string, path: string, options?: { limit?: number, before?: string }) => Promise<VersionsPage>} [versions]
 *   where `capabilities.versions` says so: the file's kept versions, newest first, the current one
 *   included (`current: true`), following it through renames. A path with nothing there now answers
 *   the history of the file last there (a deleted file's, until the sweep takes it); a path no file
 *   was ever at is `not-found`, and a folder `type`. `before` is a previous page's `next`.
 * @property {(id: string, path: string, version: string) => Promise<ReadResult>} [readVersion]
 *   where `capabilities.versions` says so: one version's bytes, as `read` gives the file's. A version
 *   thinning dropped, or one that isn't this file's, is `not-found`.
 * @property {(id: string, path: string, version: string, options?: WriteOptions) => Promise<{ entry: Entry, version: string, cursor: string }>} [restore]
 *   where `capabilities.versions` says so: makes that version the file's newest, as a new revision
 *   over the same bytes, logged as a `write` by the restorer with `restoredFrom`; answers as `write`
 *   does. `ifMatch` the current version, or `ifAbsent` when the file is gone now. The version it
 *   replaces stays in history. Bytes equal to the file's now change nothing, as an identical write.
 * @property {(id: string, options?: { actor?: Actor }) => Promise<RemovedProject>} [removeProject]
 *   where `capabilities.removeProject` says so: the project leaves `listProjects` and answers
 *   `no-project`, its feeds end, and the removal is logged; it can come back until `purgeAfter`, and
 *   its id stays taken
 * @property {() => Promise<RemovedProject[]>} [removedProjects]  the projects removed and not yet purged
 * @property {(id: string, options?: { actor?: Actor }) => Promise<ProjectInfo>} [restoreProject]
 *   a removed project back as it was, logged; one purged or never removed is `no-project`
 * @property {(id: string, options?: { limit?: number }) => Promise<{ files: DeletedFile[], more: boolean }>} [deletedFiles]
 *   where `capabilities.deletedFiles` says so: the files deleted and still restorable, newest delete first, each once
 * @property {() => void} close  stops watching and ends every feed
 */

/**
 * Every refusal a backend or the HTTP layer can answer, and its HTTP status: one table, so the
 * same refusal reads the same from every backend. The client tells them apart by code
 * (src/files/serverStore.ts `failure`).
 */
export const ERRORS = Object.freeze({
  'invalid-path': 400,
  'invalid-context': 400,
  'invalid-query': 400,
  'into-itself': 400,
  'project-meta': 400,
  'signed-out': 401,
  hidden: 403,
  symlink: 403,
  'read-only': 403,
  permission: 403,
  'cross-site': 403,
  'not-found': 404,
  'no-project': 404,
  'no-route': 404,
  method: 405,
  type: 409,
  exists: 409,
  changed: 409,
  precondition: 412,
  'too-large': 413,
  'too-big': 413,
  host: 421,
  busy: 503,
  'disk-full': 507,
  'space-full': 507,
  internal: 500,
})

/** A refusal a person can be told, by code (ERRORS), with details the client reads (`exists`, `absent`, `expected`). */
export class BackendError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'BackendError'
    this.code = code
    this.extra = extra
  }

  get status() {
    return ERRORS[this.code] ?? 500
  }
}

// --- the rules every backend keeps ---------------------------------------------------------------

export const META_PATH = '.nebula/project.json'
export const META_MAX = 1024 * 1024
export const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
export const PLANETS = ['#7c8cff', '#a78bfa', '#e879f9', '#f472b6', '#fb7a5a', '#fbbf24', '#4ade80', '#2dd4bf', '#38d1eb', '#60a5fa', '#a8b0c4']
const COLOUR = /^#[0-9a-f]{6}$/i
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const OS_FILES = new Set(['thumbs.db', 'desktop.ini'])
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const encoder = new TextEncoder()

/** Nebula's path rules (src/files/paths.ts pathProblem), kept in step by tests/serverTier.test.ts. */
export function pathProblem(path) {
  if (typeof path !== 'string') return 'not a string'
  if (path === '') return 'empty'
  if (path.startsWith('/')) return 'absolute'
  if (path.includes('\\')) return 'backslash'
  if (CONTROL.test(path)) return 'control character'
  for (const segment of path.split('/')) {
    if (segment === '') return 'empty segment'
    if (segment === '.' || segment === '..') return `'${segment}' segment`
    if (encoder.encode(segment).length > 255) return 'segment longer than 255 bytes'
  }
  return null
}

/** Names the server never lists, watches or serves: the folder tier's skipped names
 * (src/files/folderTier.ts isSkippedInFolder). */
export function isHiddenName(name) {
  // Compared without regard to case: on a case-insensitive disk (macOS, Windows) NODE_MODULES is node_modules.
  const lower = name.toLowerCase()
  return name.startsWith('.') || lower.endsWith('.crswap') || lower === 'node_modules' || OS_FILES.has(lower)
}

export function isInside(path, folder) {
  return path === folder || path.startsWith(`${folder}/`)
}

/** The path's segments, or BackendError. A hidden name is refused anywhere, except the root's
 * `.nebula/` and the plain names inside it. `eachSegment` adds a backend's own rule (a Windows
 * server's aliases). */
export function servedSegments(path, eachSegment = () => {}) {
  const problem = pathProblem(path)
  if (problem) throw new BackendError('invalid-path', `Invalid path ${JSON.stringify(path)}: ${problem}`)
  const segments = path.split('/')
  segments.forEach((segment, index) => {
    eachSegment(segment)
    const own = index === 0 && segment === '.nebula'
    const insideOwn = index > 0 && segments[0] === '.nebula' && !segment.startsWith('.')
    if (isHiddenName(segment) && !own && !insideOwn) {
      throw new BackendError('hidden', `${JSON.stringify(path)} isn't served: a hidden name (${segment})`)
    }
  })
  return segments
}

/** `.nebula` stays the project's own: nothing moves into or out of it, and it isn't removed. */
export function refuseOwnMove(from, to) {
  if (from.split('/')[0] === '.nebula' || to.split('/')[0] === '.nebula') throw new BackendError('hidden', `.nebula is the project's own: nothing moves in or out of it`)
}

export function refuseOwnRemove(path) {
  if (path === '.nebula') throw new BackendError('hidden', `.nebula is the project's own`)
}

/** A project.json written through the API stays this project's: JSON, under the cap, its id unchanged. */
export function checkMeta(text, size, id) {
  if (size > META_MAX) throw new BackendError('too-large', `project.json is over ${META_MAX} bytes`)
  let meta
  try {
    meta = JSON.parse(text)
  } catch {
    throw new BackendError('project-meta', 'project.json must be JSON')
  }
  if (meta?.id !== id) throw new BackendError('project-meta', "project.json keeps the project's id")
}

/** Whether parsed project.json content names a usable id. */
export function hasProjectId(meta) {
  return typeof meta?.id === 'string' && ID_PATTERN.test(meta.id) && meta.id !== '.' && meta.id !== '..'
}

/** project.json's fields as every backend serves them: a missing or odd field takes its fallback. */
export function projectInfoOf(meta, fallback) {
  return {
    id: meta.id,
    name: typeof meta.name === 'string' && meta.name.trim() ? meta.name : fallback.name,
    color: typeof meta.color === 'string' && COLOUR.test(meta.color) ? meta.color.toLowerCase() : fallback.color,
    created: typeof meta.created === 'string' ? meta.created : new Date(0).toISOString(),
    createdBy: typeof meta.createdBy === 'string' ? meta.createdBy : fallback.createdBy,
  }
}

/** Ten random characters of [a-z0-9], as the browser's registry makes them. */
export function newProjectId(randomBytes) {
  const id = []
  while (id.length < 10) {
    for (const byte of randomBytes(16)) if (byte < 252 && id.length < 10) id.push(ID_ALPHABET[byte % 36])
  }
  return id.join('')
}

/** A change record's own fields, in a fixed order, leaving out what is absent. */
export function changeRecord({ seq, cursor, project, change, actor, context, client, restoredFrom, at = new Date() }) {
  const record = { seq, cursor, at: at.toISOString(), project, type: change.type }
  if (change.type === 'rename') Object.assign(record, { from: change.from, to: change.to })
  else record.path = change.path
  if (actor) record.actor = actor
  if (context) record.context = context
  if (client) record.client = client
  if (restoredFrom) record.restoredFrom = restoredFrom
  return record
}

/** The change a client applies (`FileChange` in src/files/types.ts), from a record. */
export function changeOf(record) {
  return record.type === 'rename' ? { type: 'rename', from: record.from, to: record.to } : { type: record.type, path: record.path }
}

/** Whether a record touches `path` (or what is in it), at either end of a rename. */
export function touches(record, path) {
  return record.type === 'rename' ? isInside(record.from, path) || isInside(record.to, path) : isInside(record.path, path)
}

/**
 * Who last wrote each file through Nebula, kept from the records as they happen: a write with an
 * actor names it, one without (another program) forgets it, and removes and renames follow the tree.
 */
export class Authors {
  constructor() {
    this.byPath = new Map()
  }

  note(record) {
    if (record.type === 'write') {
      if (record.actor) this.byPath.set(record.path, record.actor)
      else this.byPath.delete(record.path)
    } else if (record.type === 'remove') this.drop(record.path)
    else if (record.type === 'rename') {
      const moved = [...this.byPath].filter(([path]) => isInside(path, record.from))
      this.drop(record.from)
      for (const [path, actor] of moved) this.byPath.set(record.to + path.slice(record.from.length), actor)
    }
  }

  drop(path) {
    for (const known of [...this.byPath.keys()]) if (isInside(known, path)) this.byPath.delete(known)
  }

  /** The entry, with `modifiedBy` when it is known. */
  of(entry) {
    const actor = entry.type === 'file' ? this.byPath.get(entry.path) : undefined
    return actor ? { ...entry, modifiedBy: actor } : entry
  }
}

/**
 * The newest records first, across a backend's projects, from records each holding `order` (the
 * backend's own count, never reused in its lifetime). `before` is a previous page's `next`.
 */
export function recentPage(records, { project, path, limit = 50, before } = {}) {
  const until = before === undefined || before === null || before === '' ? Infinity : Number(before)
  const page = []
  for (let index = records.length - 1; index >= 0 && page.length < limit; index -= 1) {
    const { order, record } = records[index]
    if (!(order < until)) continue
    if (project && record.project !== project) continue
    if (path && !touches(record, path)) continue
    page.push({ order, record })
  }
  const next = page.length === limit && page.length > 0 ? String(page[page.length - 1].order) : null
  return { changes: page.map(({ record }) => record), next }
}
