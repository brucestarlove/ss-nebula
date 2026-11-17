// Nebula's server tier: projects that are real folders on a computer or a
// server, served to the Nebula app on the same origin. Node built-ins only.
//
//   GET    /nebula-api/v1/place                              where this is, and its projects
//   GET    /nebula-api/v1/projects/<id>/state                the project's change cursor
//   GET    /nebula-api/v1/projects/<id>/list                 every file and folder
//   GET    /nebula-api/v1/projects/<id>/stat?path=           one entry, or 404
//   GET    /nebula-api/v1/projects/<id>/file?path=           a file's bytes, with its ETag
//   PUT    /nebula-api/v1/projects/<id>/file?path=           replace whole (If-Match, If-None-Match: *)
//   POST   /nebula-api/v1/projects/<id>/mkdir?path=
//   POST   /nebula-api/v1/projects/<id>/rename?from=&to=     refuses an existing target
//   DELETE /nebula-api/v1/projects/<id>/file?path=           a file, or a folder and all in it
//   GET    /nebula-api/v1/projects/<id>/events?since=        Server-Sent Events, resumable
//
// It answers only the Host names it serves (loopback, plus --allow-host), refuses cross-site
// requests (Sec-Fetch-Site, Origin) and sends no CORS headers, so a web page elsewhere can't drive
// it through the browser. Paths follow Nebula's rules (src/files/paths.ts); a dot-name, node_modules
// or a symlink anywhere on a path is refused, so `.git`, `.env` and links out of the root stay out
// of reach (the project's own `.nebula/` is the one dot-folder it serves). Writes land whole: a
// temporary file in `.nebula/`, then link (create only) or rename. Changes made by anyone else are
// watched folder by folder on Linux (hidden names and node_modules cost nothing), natively recursive
// where the system does that (macOS, Windows).
import { randomBytes, createHash } from 'node:crypto'
import { createReadStream, constants as FS, watch as fsWatch } from 'node:fs'
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, join, sep } from 'node:path'

export const API = '/nebula-api/v1'
export const SERVER_TIMING = 'nebula-files;desc="1"'

const MAX_ENTRIES = 20_000
const META_MAX = 1024 * 1024
const RING = 2_000
const RECENT_MS = 2_000
// Watching others' changes: one watcher per served folder costs about 1.2 KB (measured on
// Node 24, Linux), so these keep the whole watch near 10 MB however big a project is.
const MAX_WATCHED = 3_000
const MAX_WATCHED_TOTAL = 8_000
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
const COLOUR = /^#[0-9a-f]{6}$/i
const CLIENT = /^[A-Za-z0-9_-]{8,64}$/
const PLANETS = ['#7c8cff', '#a78bfa', '#e879f9', '#f472b6', '#fb7a5a', '#fbbf24', '#4ade80', '#2dd4bf', '#38d1eb', '#60a5fa', '#a8b0c4']
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const OS_FILES = new Set(['thumbs.db', 'desktop.ini'])
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const encoder = new TextEncoder()

class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

/** Nebula's path rules (src/files/paths.ts pathProblem), kept in step by tests/nebulaFiles.test.mjs. */
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

/** Whether a name is a way to say another name on Windows' disks: a ':' (an alternate
 * data stream: `.git:x`), an 8.3 short name (`GIT~1` is `.git`, `NODE_M~1` is `node_modules`), or one
 * ending in a dot or a space (which Windows drops: `.git.` is `.git`). */
export function isWindowsAlias(name) {
  return name.includes(':') || /^[^.~]{1,8}~\d+(\.[^.]{0,3})?$/.test(name) || /[. ]$/.test(name)
}

const ON_WINDOWS = process.platform === 'win32'

function refuseAlias(segment) {
  if (!isWindowsAlias(segment)) return
  throw new ApiError(400, 'invalid-path', `${JSON.stringify(segment)} isn't a name Nebula writes: a name can't hold ':' or end in a dot or space, and ones shaped like Windows' short names (GIT~1) are left alone`)
}

/** Off Windows, ':' and a trailing dot or space are ordinary names that every tier writes (the
 * store's conformance: `Plans: phase 1?.md`, `notes.`), so a new name is refused only when it could
 * be a hidden name on a Windows or case-insensitive disk mounted here: what is left of it before a
 * ':' or without its trailing dots and spaces is hidden, or it has a short name's shape. */
function refuseHiddenAlias(segment) {
  const base = segment.split(':')[0].replace(/[. ]+$/, '')
  if (isHiddenName(base) || /^[^.~]{1,8}~\d+(\.[^.]{0,3})?$/.test(segment)) refuseAlias(segment)
}

/** The names a write is about to make (from `missing`, the first segment that isn't there yet; none if it all is). */
function refuseAliases(segments, missing) {
  if (missing !== undefined) segments.slice(missing).forEach(ON_WINDOWS ? refuseAlias : refuseHiddenAlias)
}

/** The path's segments, or ApiError. A hidden name is refused anywhere, except the root's
 * `.nebula/` and the plain names inside it. */
function segmentsOf(path) {
  const problem = pathProblem(path)
  if (problem) throw new ApiError(400, 'invalid-path', `Invalid path ${JSON.stringify(path)}: ${problem}`)
  const segments = path.split('/')
  segments.forEach((segment, index) => {
    // On a Windows server nothing is reached by an alias; elsewhere only new names are checked (refuseAliases).
    if (ON_WINDOWS) refuseAlias(segment)
    const own = index === 0 && segment === '.nebula'
    const insideOwn = index > 0 && segments[0] === '.nebula' && !segment.startsWith('.')
    if (isHiddenName(segment) && !own && !insideOwn) {
      throw new ApiError(403, 'hidden', `${JSON.stringify(path)} isn't served: a hidden name (${segment})`)
    }
  })
  return segments
}

function isLoopbackAddress(address = '') {
  return address === '::1' || /^(::ffff:)?127\./.test(address)
}

function isInside(path, folder) {
  return path === folder || path.startsWith(`${folder}/`)
}

function etagOf(st) {
  return `"${st.ino.toString(36)}-${st.mtimeNs.toString(36)}-${st.size.toString(36)}"`
}

function entryOf(path, st) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return st.isDirectory()
    ? { path, name, type: 'dir' }
    : { path, name, type: 'file', size: Number(st.size), modified: Number(st.mtimeMs) }
}

/** What link(2) says on a disk that has no hard links (exFAT and FAT, some network and FUSE mounts). */
const NO_LINK = new Set(['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL'])

/**
 * Puts the file at `from` where nothing is yet, as `to`, and leaves `from` gone. It never replaces
 * what is there: a hard link refuses an existing name (EEXIST). Where the disk has no link(2)
 * (`noLink`, or when the link says so), the name is taken first by an exclusive create (EEXIST
 * again), then the file is renamed over that empty file of our own. Only that empty file can be
 * overwritten, and only by someone who wrote into it in the moment between the two.
 */
async function placeNew(from, to, noLink = false) {
  if (!noLink) {
    let linked = false
    try {
      await link(from, to)
      linked = true
    } catch (error) {
      if (!NO_LINK.has(error.code)) throw error
    }
    if (linked) return unlink(from)
  }
  const handle = await open(to, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o666)
  const made = await handle.stat()
  await handle.close()
  try {
    await rename(from, to)
  } catch (error) {
    // Remove only the empty file made above: same file, still empty. Anything else at `to` is
    // someone's, and stays (Nebula never deletes a file it can't prove it made).
    const now = await lstat(to).catch(() => null)
    if (now && now.isFile() && now.ino === made.ino && now.dev === made.dev && now.size === 0) await unlink(to).catch(() => {})
    throw error
  }
}

/** Whether the disk under a project's `.nebula/` can make a hard link, tried once with two files
 * made and removed there (and nowhere else). 'unknown' when nothing can be made there at all (a
 * read-only disk, a `.nebula` that isn't a real folder): that is not the disk's lack of links. */
export async function probeLink(dir) {
  const base = join(dir, '.nebula')
  const name = `.probe-${randomBytes(6).toString('hex')}`
  const from = join(base, name)
  const to = join(base, `${name}-link`)
  try {
    const st = await lstat(base)
    if (!st.isDirectory() || st.isSymbolicLink()) return 'unknown'
    await writeFile(from, '', { flag: 'wx' })
  } catch {
    return 'unknown'
  }
  try {
    await link(from, to)
    return 'links'
  } catch (error) {
    return NO_LINK.has(error.code) ? 'none' : 'unknown'
  } finally {
    await unlink(to).catch(() => {})
    await unlink(from).catch(() => {})
  }
}

/** A file system's refusal, in words for whoever is using Nebula, or null for any other error. */
function fsProblem(error) {
  switch (error?.code) {
    case 'EROFS':
      return new ApiError(403, 'read-only', 'This folder is on a read-only disk, so nothing can be saved in it')
    case 'EACCES':
    case 'EPERM':
      return new ApiError(403, 'permission', "The server isn't allowed to write there")
    case 'ENOSPC':
    case 'EDQUOT':
      return new ApiError(507, 'disk-full', "The disk is full, so that couldn't be saved")
    default:
      return null
  }
}

function newProjectId() {
  const id = []
  while (id.length < 10) {
    for (const byte of randomBytes(16)) if (byte < 252 && id.length < 10) id.push(ID_ALPHABET[byte % 36])
  }
  return id.join('')
}

/** One project the server serves: a folder, its id and name, its change feed. */
class Project {
  constructor(dir, meta, epoch) {
    this.dir = dir
    this.meta = meta
    this.epoch = epoch
    this.seq = 0
    this.ring = []
    this.subscribers = new Set()
    this.queue = Promise.resolve()
    this.recentPaths = new Map()
    /** One native recursive watcher (macOS, Windows), or one per served folder (relative path, '' for
     * the root; Linux). */
    this.watcher = null
    this.folders = new Map()
    this.limited = false
    /** Whether the disk has no hard links, found when the project was first served (probeLink). */
    this.noLink = false
    this.pending = new Map()
    this.closed = false
  }

  /** Stops watching and ends every feed, so its clients reconnect and resync. */
  close() {
    this.closed = true
    this.watcher?.close()
    for (const watcher of this.folders.values()) watcher.close()
    this.folders.clear()
    for (const timer of this.pending.values()) clearTimeout(timer)
    for (const send of this.subscribers) send.end?.()
    this.subscribers.clear()
  }

  get cursor() {
    return `${this.epoch}:${this.seq}`
  }

  /** Mutations run one at a time, so a precondition and the write it guards are one step. */
  exclusive(action) {
    const result = this.queue.then(action, action)
    this.queue = result.catch(() => {})
    return result
  }

  emit(change, by = null) {
    this.seq += 1
    const event = { seq: this.seq, change, by }
    this.ring.push(event)
    if (this.ring.length > RING) this.ring.shift()
    for (const send of this.subscribers) send(event)
    return this.cursor
  }

  /** What this server just did to a path: 'wrote' a file, 'made' a folder, 'moved'
   * something there, or made it 'gone' (removed or renamed away). */
  touched(path, kind) {
    this.recentPaths.set(path, { at: Date.now(), kind })
  }

  /** The latest time this server did one of `kinds` to the path or a folder holding it, within
   * the last moments; 0 when it didn't. */
  touchedAt(path, kinds) {
    const now = Date.now()
    let latest = 0
    for (const [touched, { at, kind }] of this.recentPaths) {
      if (now - at > RECENT_MS) this.recentPaths.delete(touched)
      else if (kinds.includes(kind) && isInside(path, touched) && at > latest) latest = at
    }
    return latest
  }
}

/**
 * The file API. `roots` are folders served as one project each; `projectsDirs` are folders whose
 * every (non-hidden) subfolder is a project, looked at again as projects come and go.
 */
export function createFilesApi({
  roots = [],
  projectsDirs = [],
  label = hostname(),
  allowHosts = [],
  maxBytes = 256 * 1024 * 1024,
  createdBy = 'nebula-server',
  /** Answer a loopback Host name only from a loopback address (nebula run, Secu S6). Off for a
   * container, whose requests all come through its bridge. */
  loopbackPeer = false,
  /** How changes by others are watched: 'folders' (one watcher per served folder, the default on
   * Linux and elsewhere) or 'recursive' (one native watcher, the default on macOS and Windows). */
  watchMode = process.platform === 'darwin' || process.platform === 'win32' ? 'recursive' : 'folders',
  /** The most folders watched in one project, and in all (each costs about 1.2 KB). */
  maxWatched = MAX_WATCHED,
  maxWatchedTotal = MAX_WATCHED_TOTAL,
  log = () => {},
} = {}) {
  const epoch = randomBytes(6).toString('hex')
  const allowed = new Set(allowHosts.map((host) => host.toLowerCase()))
  /** id → Project; dir → id. */
  const projects = new Map()
  const byDir = new Map()
  let scanned = 0
  let scanning = null

  /** The project's own `.nebula` is a real folder (or not there yet), never a link. */
  async function ownMetaDir(dir) {
    try {
      const st = await lstat(join(dir, '.nebula'))
      return st.isDirectory() && !st.isSymbolicLink()
    } catch (error) {
      return error.code === 'ENOENT' ? null : false
    }
  }

  async function readMeta(dir) {
    try {
      if ((await ownMetaDir(dir)) !== true) return null
      const st = await lstat(join(dir, '.nebula', 'project.json'))
      if (!st.isFile() || st.size > META_MAX) return null
      const meta = JSON.parse(await readFile(join(dir, '.nebula', 'project.json'), 'utf8'))
      if (typeof meta?.id !== 'string' || !ID_PATTERN.test(meta.id) || meta.id === '.' || meta.id === '..') return null
      return meta
    } catch {
      return null
    }
  }

  /** A folder's project: its `.nebula/project.json`, made the first time (like the folder tier).
   * A folder Nebula can't write keeps an id made from where it is, so it stays the same. */
  async function adopt(dir, index) {
    let meta = await readMeta(dir)
    const metaDir = await ownMetaDir(dir)
    if (!meta && metaDir === false) {
      // A .nebula that isn't a real folder: nothing is written through it; the id comes from where it is.
      meta = { id: createHash('sha256').update(dir).digest('hex').slice(0, 10), name: basename(dir), color: PLANETS[index % PLANETS.length], created: new Date(0).toISOString(), createdBy }
    }
    if (!meta) {
      meta = {
        id: newProjectId(),
        name: basename(dir),
        color: PLANETS[index % PLANETS.length],
        created: new Date().toISOString(),
        createdBy,
      }
      try {
        await mkdir(join(dir, '.nebula'), { recursive: true })
        const temp = join(dir, '.nebula', `.project-${randomBytes(6).toString('hex')}`)
        await writeFile(temp, `${JSON.stringify(meta, null, 2)}\n`, { flag: 'wx' })
        try {
          await placeNew(temp, join(dir, '.nebula', 'project.json'))
        } finally {
          await unlink(temp).catch(() => {})
        }
      } catch {
        const again = await readMeta(dir)
        if (again) meta = again
        else meta.id = createHash('sha256').update(dir).digest('hex').slice(0, 10)
      }
    }
    return {
      id: meta.id,
      name: typeof meta.name === 'string' && meta.name.trim() ? meta.name : basename(dir),
      color: typeof meta.color === 'string' && COLOUR.test(meta.color) ? meta.color.toLowerCase() : PLANETS[index % PLANETS.length],
      created: typeof meta.created === 'string' ? meta.created : new Date(0).toISOString(),
      createdBy: typeof meta.createdBy === 'string' ? meta.createdBy : createdBy,
    }
  }

  async function candidates() {
    const dirs = []
    for (const root of roots) dirs.push(await realpath(root))
    for (const parent of projectsDirs) {
      const real = await realpath(parent)
      let names = []
      try {
        names = (await readdir(real, { withFileTypes: true })).filter((d) => d.isDirectory() && !isHiddenName(d.name)).map((d) => d.name)
      } catch (error) {
        log(`nebula-files: can't read ${real}: ${error.message}`)
      }
      for (const name of names.sort()) dirs.push(join(real, name))
    }
    return dirs
  }

  async function scan() {
    const dirs = await candidates()
    const seen = new Set()
    let index = 0
    for (const dir of dirs) {
      const meta = await adopt(dir, index++)
      const known = projects.get(meta.id)
      if (known && known.dir !== dir) {
        if (seen.has(meta.id) || (await lstat(known.dir).then(() => true, () => false))) {
          log(`nebula-files: ${dir} has the id of ${known.dir} (${meta.id}); only the first is served`)
          continue
        }
        // Its folder was renamed or moved on the server: the same project, from a fresh start.
        known.close()
        projects.delete(meta.id)
        byDir.delete(known.dir)
      }
      seen.add(meta.id)
      const kept = projects.get(meta.id)
      if (kept) kept.meta = meta
      else {
        const project = new Project(dir, meta, `${epoch}.${randomBytes(3).toString('hex')}`)
        // Once, before anything is written through it: can this disk make a hard link?
        const links = await probeLink(dir)
        project.noLink = links === 'none'
        if (project.noLink) log(`nebula-files: ${meta.name}: this disk has no hard links (exFAT, FAT and some network mounts don't), so a new file or a move is made by taking its name first and then renaming over that, instead of by link. Nothing is ever written over a file that is there. If that fails, ask the server's owner to serve a folder on another disk.`)
        else if (links === 'unknown') log(`nebula-files: ${meta.name}: nothing can be made in ${join(dir, '.nebula')} (a read-only disk or folder?), so saving there will be refused until it can`)
        projects.set(meta.id, project)
        byDir.set(dir, meta.id)
        startWatch(project)
      }
    }
    for (const [id, project] of projects) {
      if (!seen.has(id)) {
        project.close()
        projects.delete(id)
        byDir.delete(project.dir)
      }
    }
    scanned = Date.now()
  }

  function rescan(force = false) {
    if (!force && Date.now() - scanned < 1_000) return scanning ?? Promise.resolve()
    if (!scanning) scanning = scan().finally(() => { scanning = null })
    return scanning
  }

  async function projectOf(id) {
    if (!projects.has(id)) await rescan()
    const project = projects.get(id)
    if (!project) throw new ApiError(404, 'no-project', `No project ${JSON.stringify(id)} here`)
    return project
  }

  // --- the file system, walked one segment at a time ------------------------------------------

  /** Where `segments` leads: its lstat (or null when nothing is there), refusing a symlink on the
   * way, and whether a file stood where a folder was needed (`blocked`). */
  async function walk(project, segments) {
    let abs = project.dir
    for (let index = 0; index < segments.length; index += 1) {
      abs = join(abs, segments[index])
      let st
      try {
        st = await lstat(abs, { bigint: true })
      } catch (error) {
        if (error.code === 'ENOENT') return { abs: join(project.dir, ...segments), st: null, missing: index }
        if (error.code === 'ENOTDIR') return { abs: join(project.dir, ...segments), st: null, blocked: true }
        throw error
      }
      if (st.isSymbolicLink()) throw new ApiError(403, 'symlink', `${JSON.stringify(segments.slice(0, index + 1).join('/'))} is a symbolic link, which isn't served`)
      if (index < segments.length - 1 && !st.isDirectory()) return { abs: join(project.dir, ...segments), st: null, blocked: true }
      if (index === segments.length - 1) return { abs, st }
    }
    return { abs, st: null }
  }

  /** Makes the folders on the way to `segments` (not the last), as `mkdir -p` would, refusing a
   * file or a link where a folder should be. Returns the paths it made. */
  async function makeParents(project, segments) {
    const made = []
    let abs = project.dir
    for (let index = 0; index < segments.length - 1; index += 1) {
      abs = join(abs, segments[index])
      const path = segments.slice(0, index + 1).join('/')
      try {
        const st = await lstat(abs)
        if (st.isSymbolicLink()) throw new ApiError(403, 'symlink', `${JSON.stringify(path)} is a symbolic link, which isn't served`)
        if (!st.isDirectory()) throw new ApiError(409, 'type', `${JSON.stringify(path)} is a file, not a folder`, { expected: 'folder' })
      } catch (error) {
        if (error instanceof ApiError) throw error
        if (error.code !== 'ENOENT') throw error
        try {
          await mkdir(abs)
          made.push(path)
        } catch (made_) {
          if (made_.code !== 'EEXIST') throw made_
        }
      }
    }
    return made
  }

  async function list(project) {
    const entries = []
    async function visit(abs, prefix) {
      let items
      try {
        items = await readdir(abs, { withFileTypes: true })
      } catch (error) {
        if (error.code === 'ENOENT' && prefix) return
        throw error
      }
      for (const item of items) {
        if (isHiddenName(item.name) || item.isSymbolicLink()) continue
        const path = prefix ? `${prefix}/${item.name}` : item.name
        if (pathProblem(path)) continue
        const child = join(abs, item.name)
        let st
        try {
          st = await lstat(child, { bigint: true })
        } catch {
          continue
        }
        if (st.isDirectory()) {
          entries.push(entryOf(path, st))
          if (entries.length > MAX_ENTRIES) throw new ApiError(413, 'too-big', `${project.meta.name} holds more than ${MAX_ENTRIES} files and folders`)
          await visit(child, path)
        } else if (st.isFile()) {
          entries.push(entryOf(path, st))
          if (entries.length > MAX_ENTRIES) throw new ApiError(413, 'too-big', `${project.meta.name} holds more than ${MAX_ENTRIES} files and folders`)
        }
      }
    }
    await visit(project.dir, '')
    return entries
  }

  async function receive(req, project) {
    const own = await ownMetaDir(project.dir)
    if (own === false) throw new ApiError(403, 'symlink', `${project.meta.name}'s .nebula isn't a real folder, so nothing is written`)
    if (own === null) await mkdir(join(project.dir, '.nebula'))
    const temp = join(project.dir, '.nebula', `.upload-${randomBytes(8).toString('hex')}`)
    const handle = await open(temp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o666)
    let size = 0
    try {
      for await (const chunk of req) {
        size += chunk.length
        if (size > maxBytes) throw new ApiError(413, 'too-large', `The file is over ${maxBytes} bytes`)
        await handle.write(chunk)
      }
      await handle.sync()
    } catch (error) {
      await handle.close().catch(() => {})
      await unlink(temp).catch(() => {})
      throw error
    }
    await handle.close()
    return temp
  }

  async function write(req, project, path, clientId) {
    const segments = segmentsOf(path)
    const ifMatch = req.headers['if-match']
    const ifNoneMatch = req.headers['if-none-match']
    const createParents = req.headers['nebula-parents'] !== 'existing'
    const temp = await receive(req, project)
    try {
      if (path === '.nebula/project.json') await checkMeta(temp, project)
      return await project.exclusive(async () => {
        let at = await walk(project, segments)
        if (at.blocked) throw new ApiError(409, 'type', `${JSON.stringify(path)} goes through a file`, { expected: 'folder' })
        if (!at.st) refuseAliases(segments, at.missing)
        if (!at.st && at.missing !== undefined && at.missing < segments.length - 1) {
          if (!createParents) throw new ApiError(404, 'not-found', `The folder for ${JSON.stringify(path)} is gone`)
          for (const made of await makeParents(project, segments)) project.touched(made, 'made')
          at = await walk(project, segments)
        }
        if (ifNoneMatch === '*') {
          if (at.st) throw new ApiError(412, 'precondition', `Something already exists at ${JSON.stringify(path)}`, { exists: true })
        } else if (ifMatch) {
          if (!at.st || !at.st.isFile()) throw new ApiError(412, 'precondition', `${JSON.stringify(path)} is gone, or isn't a file`, { absent: true })
          if (etagOf(at.st) !== ifMatch) throw new ApiError(412, 'precondition', `${JSON.stringify(path)} changed`, { absent: false })
        }
        if (at.st && !at.st.isFile()) throw new ApiError(409, 'type', `${JSON.stringify(path)} is a folder`, { expected: 'file' })
        if (ifNoneMatch === '*') {
          try {
            await placeNew(temp, at.abs, project.noLink)
          } catch (error) {
            if (error.code === 'EEXIST') throw new ApiError(412, 'precondition', `Something already exists at ${JSON.stringify(path)}`, { exists: true })
            throw error
          }
        } else {
          await rename(temp, at.abs)
        }
        const st = await lstat(at.abs, { bigint: true })
        const etag = etagOf(st)
        project.touched(path, 'wrote')
        const cursor = project.emit({ type: 'write', path }, clientId)
        return { status: 200, body: { entry: entryOf(path, st), etag, cursor }, headers: { etag } }
      })
    } finally {
      await unlink(temp).catch(() => {})
    }
  }

  /** A project.json written through the API stays this project's: JSON, under the cap, its id
   * unchanged. */
  async function checkMeta(temp, project) {
    const st = await lstat(temp)
    if (st.size > META_MAX) throw new ApiError(413, 'too-large', `project.json is over ${META_MAX} bytes`)
    let meta
    try {
      meta = JSON.parse(await readFile(temp, 'utf8'))
    } catch {
      throw new ApiError(400, 'project-meta', 'project.json must be JSON')
    }
    if (meta?.id !== project.meta.id) throw new ApiError(400, 'project-meta', "project.json keeps the project's id")
  }

  async function makeDir(project, path, clientId) {
    const segments = segmentsOf(path)
    return project.exclusive(async () => {
      const at = await walk(project, segments)
      if (at.blocked) throw new ApiError(409, 'type', `${JSON.stringify(path)} goes through a file`, { expected: 'folder' })
      if (!at.st) refuseAliases(segments, at.missing)
      if (at.st) {
        if (!at.st.isDirectory()) throw new ApiError(409, 'type', `${JSON.stringify(path)} is a file`, { expected: 'folder' })
        return { status: 200, body: { changed: false, cursor: project.cursor } }
      }
      for (const made of await makeParents(project, segments)) project.touched(made, 'made')
      try {
        await mkdir(at.abs)
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
      project.touched(path, 'made')
      const cursor = project.emit({ type: 'mkdir', path }, clientId)
      return { status: 200, body: { changed: true, cursor } }
    })
  }

  async function move(project, from, to, clientId) {
    const fromSegments = segmentsOf(from)
    const toSegments = segmentsOf(to)
    if (fromSegments[0] === '.nebula' || toSegments[0] === '.nebula') throw new ApiError(403, 'hidden', `.nebula is the project's own: nothing moves in or out of it`)
    return project.exclusive(async () => {
      const source = await walk(project, fromSegments)
      if (!source.st) throw new ApiError(404, 'not-found', `Nothing exists at ${JSON.stringify(from)}`)
      const target = await walk(project, toSegments)
      if (target.st || from === to) throw new ApiError(409, 'exists', `Something already exists at ${JSON.stringify(to)}`)
      if (target.blocked) throw new ApiError(409, 'type', `${JSON.stringify(to)} goes through a file`, { expected: 'folder' })
      refuseAliases(toSegments, target.missing)
      if (isInside(to, from)) throw new ApiError(400, 'into-itself', `A folder can't move into itself`)
      for (const made of await makeParents(project, toSegments)) project.touched(made, 'made')
      if (source.st.isFile()) {
        // link + unlink: a file that appeared at `to` meanwhile is never replaced.
        try {
          await placeNew(source.abs, target.abs, project.noLink)
        } catch (error) {
          if (error.code === 'EEXIST') throw new ApiError(409, 'exists', `Something already exists at ${JSON.stringify(to)}`)
          throw error
        }
      } else {
        await rename(source.abs, target.abs)
      }
      project.touched(from, 'gone')
      project.touched(to, 'moved')
      const cursor = project.emit({ type: 'rename', from, to }, clientId)
      return { status: 200, body: { cursor } }
    })
  }

  async function remove(project, path, clientId) {
    const segments = segmentsOf(path)
    if (segments[0] === '.nebula' && segments.length === 1) throw new ApiError(403, 'hidden', `.nebula is the project's own`)
    return project.exclusive(async () => {
      const at = await walk(project, segments)
      if (!at.st) throw new ApiError(404, 'not-found', `Nothing exists at ${JSON.stringify(path)}`)
      await rm(at.abs, { recursive: true, force: false })
      project.touched(path, 'gone')
      const cursor = project.emit({ type: 'remove', path }, clientId)
      return { status: 200, body: { cursor } }
    })
  }

  // --- changes made by anyone else: an agent, an editor, nebula-store ------------------------

  /** A change somewhere under the project, told by a watcher: looked at once it has been quiet for a
   * moment. Hidden names, node_modules and the like are dropped here, so they cost nothing. */
  function changed(project, path) {
    if (path.split('/').some(isHiddenName) || pathProblem(path)) return
    clearTimeout(project.pending.get(path))
    project.pending.set(path, setTimeout(() => {
      project.pending.delete(path)
      void observe(project, path)
    }, 40))
  }

  function startWatch(project) {
    if (watchMode === 'recursive') {
      try {
        project.watcher = fsWatch(project.dir, { recursive: true, persistent: false }, (_type, filename) => {
          if (filename) changed(project, String(filename).split(sep).join('/'))
        })
        project.watcher.on('error', (error) => {
          log(`nebula-files: watching ${project.dir} stopped (${error.message}); starting again in 5 s`)
          project.watcher?.close()
          project.watcher = null
          setTimeout(() => {
            if (!project.closed) startWatch(project)
          }, 5_000).unref()
        })
      } catch (error) {
        log(`nebula-files: can't watch ${project.dir}: ${error.message}`)
      }
      return
    }
    watchTree(project, '', false).catch((error) => log(`nebula-files: can't watch ${project.dir}: ${error.message}`))
  }

  const watchedInAll = () => [...projects.values()].reduce((sum, each) => sum + each.folders.size, 0)

  const folderPath = (project, rel) => (rel ? join(project.dir, ...rel.split('/')) : project.dir)

  /** Said once per project: what past the limit isn't watched, and what that means. */
  function limitReached(project, why) {
    if (project.limited) return
    project.limited = true
    log(`nebula-files: ${project.meta.name} has more folders than can be watched (${why}). Changes made outside Nebula in the folders past the limit aren't told live; Nebula's own changes always are, and the project lists them all.`)
  }

  /** Watches one folder (not what is in it), unless it already is. False when it couldn't be. */
  function watchFolder(project, rel) {
    if (project.folders.has(rel)) return true
    if (project.folders.size >= maxWatched || watchedInAll() >= maxWatchedTotal) {
      limitReached(project, project.folders.size >= maxWatched ? `${maxWatched} for one project` : `${maxWatchedTotal} for this server`)
      return false
    }
    const abs = folderPath(project, rel)
    const self = basename(abs)
    let watcher
    try {
      watcher = fsWatch(abs, { persistent: false }, (_type, filename) => {
        if (!filename) return
        const name = String(filename)
        const child = rel ? `${rel}/${name}` : name
        if (name !== self) return changed(project, child)
        // The system names a folder's own removal or move by its own name: a file called that inside
        // it is a file; otherwise it is this folder, whose watcher now follows what is gone or moved
        // (so it stops), and which its parent's watcher reports as well.
        lstat(join(abs, name)).then(
          () => changed(project, child),
          () => {
            if (!rel) return
            if (project.folders.get(rel) === watcher) {
              watcher.close()
              project.folders.delete(rel)
            }
            changed(project, rel)
          },
        )
      })
    } catch (error) {
      if (error.code === 'ENOSPC' || error.code === 'EMFILE') limitReached(project, `the system's limit on watched folders is reached; on Linux, raise fs.inotify.max_user_watches`)
      else if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') log(`nebula-files: can't watch ${abs}: ${error.message}`)
      return false
    }
    watcher.on('error', (error) => {
      log(`nebula-files: watching ${abs} stopped (${error.message}); starting again in 5 s`)
      unwatch(project, rel, false)
      setTimeout(() => {
        if (!project.closed) watchTree(project, rel, true).catch(() => {})
      }, 5_000).unref()
    })
    project.folders.set(rel, watcher)
    return true
  }

  /** Watches the folder and the folders in it, shallowest first, so a project past the limit is
   * watched where it matters most. `announce` tells what was already in a folder that wasn't watched
   * (one that appeared, or whose watcher started again): nothing was there to hear it. */
  async function watchTree(project, start, announce) {
    const queue = [start]
    while (queue.length > 0 && !project.closed) {
      const rel = queue.shift()
      if (project.folders.has(rel)) continue
      if (!watchFolder(project, rel)) {
        if (project.limited) break
        continue
      }
      let items
      try {
        items = await readdir(folderPath(project, rel), { withFileTypes: true })
      } catch {
        continue
      }
      for (const item of items) {
        if (isHiddenName(item.name) || item.isSymbolicLink()) continue
        const path = rel ? `${rel}/${item.name}` : item.name
        if (pathProblem(path)) continue
        if (item.isDirectory()) queue.push(path)
        if (announce && (item.isDirectory() || item.isFile())) changed(project, path)
      }
    }
  }

  /** Stops watching a folder and the folders in it (they're gone, or moved). */
  function unwatch(project, path, below = true) {
    for (const [rel, watcher] of project.folders) {
      if (rel === path || (below && rel.startsWith(`${path}/`))) {
        watcher.close()
        project.folders.delete(rel)
      }
    }
  }

  async function observe(project, path) {
    let st = null
    try {
      st = (await walk(project, path.split('/'))).st
    } catch {
      return
    }
    // A folder that appeared (or moved in) is watched, with the folders in it; one that went isn't.
    if (watchMode === 'folders' && !project.closed) {
      if (st?.isDirectory()) watchTree(project, path, true).catch(() => {})
      else if (!st) unwatch(project, path)
    }
    // What this server did itself was said already, by whoever asked, and only that is kept quiet: a file it wrote or moved (written before it did), a folder it made or moved, a
    // path it removed or renamed away. Anyone else's change to the same path is told.
    if (st?.isFile()) {
      const touched = project.touchedAt(path, ['wrote', 'moved'])
      if (touched && Number(st.mtimeMs) <= touched) return
      project.emit({ type: 'write', path })
    } else if (st?.isDirectory()) {
      if (project.touchedAt(path, ['made', 'moved'])) return
      project.emit({ type: 'mkdir', path })
    } else if (!st) {
      if (project.touchedAt(path, ['gone'])) return
      project.emit({ type: 'remove', path })
    }
  }

  function events(req, res, project) {
    const since = new URL(req.url, 'http://x').searchParams.get('since') ?? req.headers['last-event-id'] ?? ''
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    })
    const send = (event) => res.write(`id: ${project.epoch}:${event.seq}\nevent: change\ndata: ${JSON.stringify({ change: event.change, by: event.by })}\n\n`)
    send.end = () => res.end()
    res.write('retry: 2000\n\n')
    const [sinceEpoch, sinceSeq] = String(since).split(':')
    const seq = Number(sinceSeq)
    const oldest = project.ring[0]?.seq ?? project.seq + 1
    // `ready` comes before what was missed, so a client says it's back before it says what changed.
    const ready = () => res.write(`event: ready\ndata: ${JSON.stringify({ cursor: project.cursor })}\n\n`)
    if (sinceEpoch !== project.epoch || !Number.isInteger(seq) || seq > project.seq || seq < oldest - 1) {
      res.write(`id: ${project.cursor}\nevent: resync\ndata: {}\n\n`)
      ready()
    } else {
      ready()
      for (const event of project.ring) if (event.seq > seq) send(event)
    }
    project.subscribers.add(send)
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
    const stop = () => {
      clearInterval(ping)
      project.subscribers.delete(send)
    }
    req.on('close', stop)
    res.on('error', stop)
  }

  // --- requests ------------------------------------------------------------------------------

  /** Whether a request may reach the API: a Host this serves, and never another site. */
  function refusal(req) {
    const host = String(req.headers.host ?? '').toLowerCase()
    const hosts = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'host').length
    let name = ''
    try {
      name = hosts === 1 && !/[/?#@\\]/.test(host) ? new URL(`http://${host}`).hostname : ''
    } catch {
      // not a host name
    }
    if (!LOOPBACK.has(name) && !allowed.has(name)) return [421, 'host', `This server doesn't answer for ${JSON.stringify(host)}`]
    // nebula run on a laptop: a loopback name counts only from this machine.
    if (loopbackPeer && LOOPBACK.has(name) && !isLoopbackAddress(req.socket.remoteAddress)) return [421, 'host', 'A loopback name from another machine']
    const site = req.headers['sec-fetch-site']
    const safe = req.method === 'GET' || req.method === 'HEAD'
    if (site && site !== 'same-origin' && !(site === 'none' && safe)) return [403, 'cross-site', 'Another site asked']
    const origin = req.headers.origin
    if (origin !== undefined) {
      let originHost = null
      try {
        originHost = new URL(origin).host.toLowerCase()
      } catch {
        // an opaque origin ("null")
      }
      if (originHost !== host) return [403, 'cross-site', 'Another site asked']
    }
    return null
  }

  function reply(res, status, body, headers = {}) {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    })
    res.end(text)
  }

  function place(req) {
    const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'
    return {
      version: 1,
      place: { tier: 'server', label, url: `${proto}://${req.headers.host}` },
      projects: [...projects.values()].map((project) => ({ ...project.meta, folder: basename(project.dir) })),
    }
  }

  async function route(req, res, url) {
    const rest = url.pathname.slice(API.length)
    if (rest === '/place' && req.method === 'GET') {
      await rescan(true)
      return reply(res, 200, place(req))
    }
    const match = /^\/projects\/([^/]+)\/(state|list|stat|file|mkdir|rename|events)$/.exec(rest)
    if (!match) throw new ApiError(404, 'no-route', 'Not part of the file API')
    let projectId
    try {
      projectId = decodeURIComponent(match[1])
    } catch {
      throw new ApiError(404, 'no-project', 'No such project here')
    }
    const project = await projectOf(projectId)
    const action = match[2]
    const path = url.searchParams.get('path') ?? ''
    const clientHeader = req.headers['nebula-client']
    const clientId = typeof clientHeader === 'string' && CLIENT.test(clientHeader) ? clientHeader : null
    const cursor = { 'nebula-cursor': project.cursor }

    if (action === 'state' && req.method === 'GET') return reply(res, 200, { cursor: project.cursor, project: project.meta })
    if (action === 'list' && req.method === 'GET') return reply(res, 200, { entries: await list(project), cursor: project.cursor })
    if (action === 'events' && req.method === 'GET') return events(req, res, project)
    if (action === 'stat' && req.method === 'GET') {
      const at = await walk(project, segmentsOf(path))
      if (!at.st || !(at.st.isFile() || at.st.isDirectory())) throw new ApiError(404, 'not-found', `Nothing exists at ${JSON.stringify(path)}`)
      return reply(res, 200, { entry: entryOf(path, at.st), etag: at.st.isFile() ? etagOf(at.st) : null }, cursor)
    }
    if (action === 'file' && (req.method === 'GET' || req.method === 'HEAD')) {
      const at = await walk(project, segmentsOf(path))
      if (!at.st) throw new ApiError(404, 'not-found', `Nothing exists at ${JSON.stringify(path)}`)
      if (!at.st.isFile()) throw new ApiError(409, 'type', `${JSON.stringify(path)} is a folder`, { expected: 'file' })
      const handle = await open(at.abs, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK)
      let st
      try {
        st = await handle.stat({ bigint: true })
        // The file opened must be the one the walk checked: a folder swapped for a link meanwhile
        // leads somewhere else (Secu round 1, the TOCTOU gap).
        if (!st.isFile() || st.dev !== at.st.dev || st.ino !== at.st.ino) throw new ApiError(409, 'changed', `${JSON.stringify(path)} changed while it was being read`)
      } catch (error) {
        await handle.close()
        throw error
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(st.size),
        etag: etagOf(st),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      })
      if (req.method === 'HEAD') {
        await handle.close()
        return res.end()
      }
      const stream = createReadStream(null, { fd: handle, autoClose: true })
      stream.pipe(res)
      return new Promise((resolveDone) => stream.on('close', resolveDone))
    }
    if (action === 'file' && req.method === 'PUT') {
      const result = await write(req, project, path, clientId)
      return reply(res, result.status, result.body, result.headers)
    }
    if (action === 'file' && req.method === 'DELETE') {
      const result = await remove(project, path, clientId)
      return reply(res, result.status, result.body)
    }
    if (action === 'mkdir' && req.method === 'POST') {
      const result = await makeDir(project, path, clientId)
      return reply(res, result.status, result.body)
    }
    if (action === 'rename' && req.method === 'POST') {
      const result = await move(project, url.searchParams.get('from') ?? '', url.searchParams.get('to') ?? '', clientId)
      return reply(res, result.status, result.body)
    }
    throw new ApiError(405, 'method', `${req.method} isn't allowed here`)
  }

  /** Answers a request under API and returns true; returns false for anything else. */
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://nebula.local')
    if (url.pathname !== API && !url.pathname.startsWith(`${API}/`)) return false
    const refused = refusal(req)
    if (refused) {
      req.resume()
      reply(res, refused[0], { error: refused[1], message: refused[2] })
      return true
    }
    try {
      await route(req, res, url)
    } catch (error) {
      req.resume()
      if (res.headersSent) {
        res.destroy()
        return true
      }
      const known = error instanceof ApiError ? error : fsProblem(error)
      if (known) reply(res, known.status, { error: known.code, message: known.message, ...known.extra })
      else {
        log(`nebula-files: ${req.method} ${url.pathname}: ${error.stack ?? error}`)
        reply(res, 500, { error: 'internal', message: 'The server could not do that' })
      }
    }
    return true
  }

  function close() {
    for (const project of projects.values()) project.close()
  }

  return { handle, close, ready: () => rescan(true), projects: () => [...projects.values()].map((p) => ({ ...p.meta, dir: p.dir })) }
}
