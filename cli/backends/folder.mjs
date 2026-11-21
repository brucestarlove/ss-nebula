// The folder backend: projects that are real folders on a computer or a server, which agents,
// editors and scripts write too (cli/backend.mjs has the interface). Node built-ins only.
//
// Paths follow Nebula's rules (src/files/paths.ts); a dot-name, node_modules or a symlink anywhere on
// a path is refused, so `.git`, `.env` and links out of the root stay out of reach (the project's own
// `.nebula/` is the one dot-folder it serves). Writes land whole: a temporary file in `.nebula/`,
// then link (create only) or rename. Changes made by anyone else are watched folder by folder on
// Linux (hidden names and node_modules cost nothing), natively recursive where the system does that
// (macOS, Windows), and told with no actor: they were made outside Nebula.
import { randomBytes, createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { createReadStream, constants as FS, watch as fsWatch } from 'node:fs'
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import {
  Authors,
  BackendError,
  ID_PATTERN,
  META_MAX,
  META_PATH,
  PLANETS,
  changeRecord,
  checkMeta,
  hasProjectId,
  isHiddenName,
  isInside,
  newProjectId,
  pathProblem,
  projectInfoOf,
  recentPage,
  refuseOwnMove,
  refuseOwnRemove,
  servedSegments,
} from '../backend.mjs'

const MAX_ENTRIES = 20_000
const RING = 2_000
/** How many changes `recent` can look back through, across every project served. */
const HISTORY = 10_000
const RECENT_MS = 2_000
// Watching others' changes: one watcher per served folder costs about 1.2 KB (measured on
// Node 24, Linux), so these keep the whole watch near 10 MB however big a project is.
const MAX_WATCHED = 3_000
const MAX_WATCHED_TOTAL = 8_000

/** Whether a name is a way to say another name on Windows' disks: a ':' (an alternate
 * data stream: `.git:x`), an 8.3 short name (`GIT~1` is `.git`, `NODE_M~1` is `node_modules`), or one
 * ending in a dot or a space (which Windows drops: `.git.` is `.git`). */
export function isWindowsAlias(name) {
  return name.includes(':') || /^[^.~]{1,8}~\d+(\.[^.]{0,3})?$/.test(name) || /[. ]$/.test(name)
}

const ON_WINDOWS = process.platform === 'win32'
const COLOUR = /^#[0-9a-f]{6}$/i
const encoder = new TextEncoder()

/** A folder name for a new project, from its name: one line, no separator or character a disk
 * refuses, not hidden, not an alias on Windows, at most 200 bytes (leaving room for ' 2'). */
export function folderNameFor(name) {
  let base = String(name ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
  const tidy = () => (base = base.trim().replace(/^[. ]+/, '').replace(/[. ]+$/, ''))
  tidy()
  while (encoder.encode(base).length > 200) {
    base = [...base].slice(0, -1).join('')
    tidy()
  }
  // Windows' device names can't be folders there, whatever follows the dot.
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(base)) base = `${base} project`
  if (!base || isHiddenName(base) || isWindowsAlias(base) || pathProblem(base)) base = 'Project'
  return base
}

function refuseAlias(segment) {
  if (!isWindowsAlias(segment)) return
  throw new BackendError('invalid-path', `${JSON.stringify(segment)} isn't a name Nebula writes: a name can't hold ':' or end in a dot or space, and ones shaped like Windows' short names (GIT~1) are left alone`)
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

/** The path's segments, or BackendError. On a Windows server nothing is reached by an alias;
 * elsewhere only new names are checked (refuseAliases). */
function segmentsOf(path) {
  return servedSegments(path, ON_WINDOWS ? refuseAlias : () => {})
}

/** A file's version: its inode, modified time and size. */
function versionOf(st) {
  return `${st.ino.toString(36)}-${st.mtimeNs.toString(36)}-${st.size.toString(36)}`
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
      return new BackendError('read-only', 'This folder is on a read-only disk, so nothing can be saved in it')
    case 'EACCES':
    case 'EPERM':
      return new BackendError('permission', "The server isn't allowed to write there")
    case 'ENOSPC':
    case 'EDQUOT':
      return new BackendError('disk-full', "The disk is full, so that couldn't be saved")
    default:
      return null
  }
}

/** One project the backend serves: a folder, its id and name, its change feed. */
class Project {
  constructor(dir, meta, epoch, history) {
    this.dir = dir
    this.meta = meta
    this.epoch = epoch
    this.seq = 0
    this.ring = []
    /** The backend's history across projects, for `recent`: { order, record }. */
    this.history = history
    this.authors = new Authors()
    this.subscribers = new Set()
    this.queue = Promise.resolve()
    this.recentPaths = new Map()
    /** Each file told as written by someone else: how it was then (inode, size, time), so a report
     * of it unchanged isn't told again. */
    this.toldFiles = new Map()
    this.dirs = new Set()
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
    for (const subscriber of this.subscribers) subscriber.end()
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

  /** Records a change, with who made it when it was made through Nebula (none when the watcher heard it). */
  emit(change, author = {}) {
    this.noteFolders(change)
    const gone = change.type === 'remove' ? change.path : change.type === 'rename' ? change.from : null
    if (gone !== null) for (const path of [...this.toldFiles.keys()]) if (isInside(path, gone)) this.toldFiles.delete(path)
    this.seq += 1
    const record = changeRecord({ seq: this.seq, cursor: this.cursor, project: this.meta.id, change, actor: author.actor, context: author.context, client: author.client })
    this.ring.push(record)
    if (this.ring.length > RING) this.ring.shift()
    this.history.add(record)
    this.authors.note(record)
    for (const subscriber of this.subscribers) subscriber.change(record)
    return this.cursor
  }

  /**
   * The folders known to be there, so a folder told of again is never announced as new. macOS's
   * recursive watcher (FSEvents) names a folder whenever something in it changes; without this
   * every rename inside `Briefs` said `mkdir Briefs` (Bruce's 2.0.2 publish run on his Mac).
   */
  noteFolders(change) {
    const ancestors = (path) => {
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i += 1) this.dirs.add(parts.slice(0, i).join('/'))
    }
    const drop = (path) => {
      for (const dir of [...this.dirs]) if (isInside(dir, path)) this.dirs.delete(dir)
    }
    if (change.type === 'mkdir') {
      ancestors(change.path)
      this.dirs.add(change.path)
    } else if (change.type === 'write') ancestors(change.path)
    else if (change.type === 'remove') drop(change.path)
    else if (change.type === 'rename') {
      const moved = [...this.dirs].filter((dir) => isInside(dir, change.from))
      drop(change.from)
      for (const dir of moved) this.dirs.add(change.to + dir.slice(change.from.length))
      ancestors(change.to)
    }
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

/** The last changes across every project, in the order they happened. */
class History {
  constructor(limit) {
    this.limit = limit
    this.order = 0
    this.records = []
  }

  add(record) {
    this.order += 1
    this.records.push({ order: this.order, record })
    if (this.records.length > this.limit) this.records.shift()
  }
}

/**
 * The folder backend. `roots` are folders served as one project each; `projectsDirs` are folders
 * whose every (non-hidden) subfolder is a project, looked at again as projects come and go.
 * @returns {import('../backend.mjs').ProjectBackend}
 */
export function createFolderBackend({
  roots = [],
  projectsDirs = [],
  /** Who a project found when no one asked (at startup) is created by. */
  createdBy = 'nebula-server',
  /** How changes by others are watched: 'folders' (one watcher per served folder, the default on
   * Linux and elsewhere) or 'recursive' (one native watcher, the default on macOS and Windows). */
  watchMode = process.platform === 'darwin' || process.platform === 'win32' ? 'recursive' : 'folders',
  /** The most folders watched in one project, and in all (each costs about 1.2 KB). */
  maxWatched = MAX_WATCHED,
  maxWatchedTotal = MAX_WATCHED_TOTAL,
  log = () => {},
} = {}) {
  const epoch = randomBytes(6).toString('hex')
  const history = new History(HISTORY)
  /** id → Project; dir → id. */
  const projects = new Map()
  const byDir = new Map()
  let scanned = 0
  let scanning = null
  /** Folders `createProject` is making: a scan leaves them alone until their project.json is in. */
  const creating = new Set()

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
      return hasProjectId(meta) ? meta : null
    } catch {
      return null
    }
  }

  /** A folder's project: its `.nebula/project.json`, made the first time (like the folder tier),
   * created by `by`. A folder Nebula can't write keeps an id made from where it is, so it stays the same. */
  async function adopt(dir, index, by) {
    let meta = await readMeta(dir)
    const metaDir = await ownMetaDir(dir)
    const color = PLANETS[index % PLANETS.length]
    if (!meta && metaDir === false) {
      // A .nebula that isn't a real folder: nothing is written through it; the id comes from where it is.
      meta = { id: createHash('sha256').update(dir).digest('hex').slice(0, 10), name: basename(dir), color, created: new Date(0).toISOString(), createdBy: by }
    }
    if (!meta) {
      meta = { id: newProjectId(randomBytes), name: basename(dir), color, created: new Date().toISOString(), createdBy: by }
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
    return projectInfoOf(meta, { name: basename(dir), color, createdBy: by })
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
      for (const name of names.sort()) if (!creating.has(join(real, name))) dirs.push(join(real, name))
    }
    return dirs
  }

  async function scan(by) {
    const dirs = await candidates()
    const seen = new Set()
    let index = 0
    for (const dir of dirs) {
      const meta = await adopt(dir, index++, by)
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
        const project = new Project(dir, meta, `${epoch}.${randomBytes(3).toString('hex')}`, history)
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

  /** A fresh look at the folders, at most once a second unless `force`d; `actor` is who a project found now is created by. */
  function rescan(force = false, actor) {
    if (!force && Date.now() - scanned < 1_000) return scanning ?? Promise.resolve()
    if (!scanning) scanning = scan(actor?.id ?? createdBy).finally(() => { scanning = null })
    return scanning
  }

  async function projectOf(id, actor) {
    if (!projects.has(id)) await rescan(false, actor)
    const project = projects.get(id)
    if (!project) throw new BackendError('no-project', `No project ${JSON.stringify(id)} here`)
    return project
  }

  const infoOf = (project) => ({ ...project.meta, folder: basename(project.dir), dir: project.dir })

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
      if (st.isSymbolicLink()) throw new BackendError('symlink', `${JSON.stringify(segments.slice(0, index + 1).join('/'))} is a symbolic link, which isn't served`)
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
        if (st.isSymbolicLink()) throw new BackendError('symlink', `${JSON.stringify(path)} is a symbolic link, which isn't served`)
        if (!st.isDirectory()) throw new BackendError('type', `${JSON.stringify(path)} is a file, not a folder`, { expected: 'folder' })
      } catch (error) {
        if (error instanceof BackendError) throw error
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

  async function listTree(project) {
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
          if (entries.length > MAX_ENTRIES) throw new BackendError('too-big', `${project.meta.name} holds more than ${MAX_ENTRIES} files and folders`)
          await visit(child, path)
        } else if (st.isFile()) {
          entries.push({ ...entryOf(path, st), version: versionOf(st) })
          if (entries.length > MAX_ENTRIES) throw new BackendError('too-big', `${project.meta.name} holds more than ${MAX_ENTRIES} files and folders`)
        }
      }
    }
    await visit(project.dir, '')
    return entries
  }

  /** The body, into a temporary file in the project's `.nebula/`, synced to the disk. */
  async function receive(body, project) {
    const own = await ownMetaDir(project.dir)
    if (own === false) throw new BackendError('symlink', `${project.meta.name}'s .nebula isn't a real folder, so nothing is written`)
    if (own === null) await mkdir(join(project.dir, '.nebula'))
    const temp = join(project.dir, '.nebula', `.upload-${randomBytes(8).toString('hex')}`)
    const handle = await open(temp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o666)
    try {
      for await (const chunk of body) await handle.write(chunk)
      await handle.sync()
    } catch (error) {
      await handle.close().catch(() => {})
      await unlink(temp).catch(() => {})
      throw error
    }
    await handle.close()
    return temp
  }

  async function write(id, path, body, { ifMatch, ifAbsent = false, parents = true, ...author } = {}) {
    const project = await projectOf(id, author.actor)
    const segments = segmentsOf(path)
    const temp = await receive(body, project)
    try {
      if (path === META_PATH) {
        const st = await lstat(temp)
        checkMeta(st.size > META_MAX ? '' : await readFile(temp, 'utf8'), st.size, project.meta.id)
      }
      return await project.exclusive(async () => {
        let at = await walk(project, segments)
        if (at.blocked) throw new BackendError('type', `${JSON.stringify(path)} goes through a file`, { expected: 'folder' })
        if (!at.st) refuseAliases(segments, at.missing)
        if (!at.st && at.missing !== undefined && at.missing < segments.length - 1) {
          if (!parents) throw new BackendError('not-found', `The folder for ${JSON.stringify(path)} is gone`)
          for (const made of await makeParents(project, segments)) project.touched(made, 'made')
          at = await walk(project, segments)
        }
        if (ifAbsent) {
          if (at.st) throw new BackendError('precondition', `Something already exists at ${JSON.stringify(path)}`, { exists: true })
        } else if (ifMatch) {
          if (!at.st || !at.st.isFile()) throw new BackendError('precondition', `${JSON.stringify(path)} is gone, or isn't a file`, { absent: true })
          if (versionOf(at.st) !== ifMatch) throw new BackendError('precondition', `${JSON.stringify(path)} changed`, { absent: false })
        }
        if (at.st && !at.st.isFile()) throw new BackendError('type', `${JSON.stringify(path)} is a folder`, { expected: 'file' })
        if (ifAbsent) {
          try {
            await placeNew(temp, at.abs, project.noLink)
          } catch (error) {
            if (error.code === 'EEXIST') throw new BackendError('precondition', `Something already exists at ${JSON.stringify(path)}`, { exists: true })
            throw error
          }
        } else {
          await rename(temp, at.abs)
        }
        const st = await lstat(at.abs, { bigint: true })
        project.touched(path, 'wrote')
        const cursor = project.emit({ type: 'write', path }, author)
        return { entry: project.authors.of(entryOf(path, st)), version: versionOf(st), cursor }
      })
    } finally {
      await unlink(temp).catch(() => {})
    }
  }

  async function makeDir(id, path, author = {}) {
    const project = await projectOf(id, author.actor)
    const segments = segmentsOf(path)
    return project.exclusive(async () => {
      const at = await walk(project, segments)
      if (at.blocked) throw new BackendError('type', `${JSON.stringify(path)} goes through a file`, { expected: 'folder' })
      if (!at.st) refuseAliases(segments, at.missing)
      if (at.st) {
        if (!at.st.isDirectory()) throw new BackendError('type', `${JSON.stringify(path)} is a file`, { expected: 'folder' })
        return { changed: false, cursor: project.cursor }
      }
      for (const made of await makeParents(project, segments)) project.touched(made, 'made')
      try {
        await mkdir(at.abs)
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
      project.touched(path, 'made')
      const cursor = project.emit({ type: 'mkdir', path }, author)
      return { changed: true, cursor }
    })
  }

  async function move(id, from, to, author = {}) {
    const project = await projectOf(id, author.actor)
    const fromSegments = segmentsOf(from)
    const toSegments = segmentsOf(to)
    refuseOwnMove(from, to)
    return project.exclusive(async () => {
      const source = await walk(project, fromSegments)
      if (!source.st) throw new BackendError('not-found', `Nothing exists at ${JSON.stringify(from)}`)
      const target = await walk(project, toSegments)
      if (target.st || from === to) throw new BackendError('exists', `Something already exists at ${JSON.stringify(to)}`)
      if (target.blocked) throw new BackendError('type', `${JSON.stringify(to)} goes through a file`, { expected: 'folder' })
      refuseAliases(toSegments, target.missing)
      if (isInside(to, from)) throw new BackendError('into-itself', `A folder can't move into itself`)
      for (const made of await makeParents(project, toSegments)) project.touched(made, 'made')
      if (source.st.isFile()) {
        // link + unlink: a file that appeared at `to` meanwhile is never replaced.
        try {
          await placeNew(source.abs, target.abs, project.noLink)
        } catch (error) {
          if (error.code === 'EEXIST') throw new BackendError('exists', `Something already exists at ${JSON.stringify(to)}`)
          throw error
        }
      } else {
        await rename(source.abs, target.abs)
      }
      project.touched(from, 'gone')
      project.touched(to, 'moved')
      const cursor = project.emit({ type: 'rename', from, to }, author)
      return { cursor }
    })
  }

  async function remove(id, path, author = {}) {
    const project = await projectOf(id, author.actor)
    const segments = segmentsOf(path)
    refuseOwnRemove(path)
    return project.exclusive(async () => {
      const at = await walk(project, segments)
      if (!at.st) throw new BackendError('not-found', `Nothing exists at ${JSON.stringify(path)}`)
      await rm(at.abs, { recursive: true, force: false })
      project.touched(path, 'gone')
      const cursor = project.emit({ type: 'remove', path }, author)
      return { cursor }
    })
  }

  async function stat(id, path) {
    const project = await projectOf(id)
    const at = await walk(project, segmentsOf(path))
    if (!at.st || !(at.st.isFile() || at.st.isDirectory())) return null
    return { entry: project.authors.of(entryOf(path, at.st)), version: at.st.isFile() ? versionOf(at.st) : null }
  }

  async function read(id, path) {
    const project = await projectOf(id)
    const at = await walk(project, segmentsOf(path))
    if (!at.st) throw new BackendError('not-found', `Nothing exists at ${JSON.stringify(path)}`)
    if (!at.st.isFile()) throw new BackendError('type', `${JSON.stringify(path)} is a folder`, { expected: 'file' })
    const handle = await open(at.abs, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK)
    let st
    try {
      st = await handle.stat({ bigint: true })
      // The file opened must be the one the walk checked: a folder swapped for a link meanwhile
      // leads somewhere else (Secu round 1, the TOCTOU gap).
      if (!st.isFile() || st.dev !== at.st.dev || st.ino !== at.st.ino) throw new BackendError('changed', `${JSON.stringify(path)} changed while it was being read`)
    } catch (error) {
      await handle.close()
      throw error
    }
    // Cancelling the web stream destroys the file stream, and autoClose closes the file: a reader
    // that goes away mid-file leaves no FileHandle for the garbage collector, which newer Node
    // treats as an error (the 2.0.2 publish run on macOS).
    const body = Readable.toWeb(createReadStream(null, { fd: handle, autoClose: true }))
    return { body, size: Number(st.size), version: versionOf(st), entry: project.authors.of(entryOf(path, st)) }
  }

  async function changesSince(id, since) {
    const project = await projectOf(id)
    const [sinceEpoch, sinceSeq] = String(since ?? '').split(':')
    const seq = Number(sinceSeq)
    const oldest = project.ring[0]?.seq ?? project.seq + 1
    if (sinceEpoch !== project.epoch || !Number.isInteger(seq) || seq > project.seq || seq < oldest - 1) return { cursor: project.cursor, resync: true }
    return { cursor: project.cursor, changes: project.ring.filter((record) => record.seq > seq) }
  }

  async function subscribe(id, subscriber) {
    const project = await projectOf(id)
    project.subscribers.add(subscriber)
    return () => void project.subscribers.delete(subscriber)
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
    // The folders already there, so the first event inside one doesn't announce it as new.
    listTree(project).then(
      (entries) => {
        for (const entry of entries) if (entry.type === 'dir') project.dirs.add(entry.path)
      },
      () => {},
    )
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
    // path it removed or renamed away. Anyone else's change to the same path is told, with no actor.
    if (st?.isFile()) {
      const touched = project.touchedAt(path, ['wrote', 'moved'])
      if (touched && Number(st.mtimeMs) <= touched) return
      // A system may report one write more than once, later (macOS, in two batches): the file as
      // it was told is told once. A new write changes its time, size or inode, and is told.
      const now = `${st.ino}:${st.size}:${st.mtimeMs}`
      if (project.toldFiles.get(path) === now) return
      project.toldFiles.set(path, now)
      project.emit({ type: 'write', path })
    } else if (st?.isDirectory()) {
      if (project.dirs.has(path) || project.touchedAt(path, ['made', 'moved'])) {
        project.dirs.add(path)
        return
      }
      project.emit({ type: 'mkdir', path })
    } else if (!st) {
      if (project.touchedAt(path, ['gone'])) return
      project.emit({ type: 'remove', path })
    }
  }

  /** Writes a new project's `.nebula/project.json` as `adopt` does: a temporary file, then placed
   * only where nothing is. */
  async function writeMeta(dir, meta) {
    await mkdir(join(dir, '.nebula'), { recursive: true })
    const temp = join(dir, '.nebula', `.project-${randomBytes(6).toString('hex')}`)
    await writeFile(temp, `${JSON.stringify(meta, null, 2)}\n`, { flag: 'wx' })
    try {
      await placeNew(temp, join(dir, '.nebula', 'project.json'))
    } finally {
      await unlink(temp).catch(() => {})
    }
  }

  /** A new project: a new folder in the first of `projectsDirs`, named from the project's name and
   * free (' 2', ' 3' after it otherwise), claimed by mkdir, so no folder that is there is used. */
  async function createProject({ id, name, color } = {}, { actor } = {}) {
    if (projectsDirs.length === 0) throw new BackendError('method', 'This server serves its folders as they are; it has no folder to make projects in')
    if (id !== undefined && (!hasProjectId({ id }) || !ID_PATTERN.test(id))) throw new BackendError('invalid-path', `${JSON.stringify(id)} isn't a project id`)
    await rescan(true, actor)
    if (id !== undefined && projects.has(id)) throw new BackendError('exists', `A project ${JSON.stringify(id)} is here already`)
    while (id === undefined) {
      const made = newProjectId(randomBytes)
      if (!projects.has(made)) id = made
    }
    const parent = await realpath(projectsDirs[0])
    const base = folderNameFor(name)
    let dir = null
    for (let n = 1; !dir; n += 1) {
      if (n > 1_000) throw new BackendError('exists', `There are too many folders named ${JSON.stringify(base)} already`)
      const candidate = join(parent, n === 1 ? base : `${base} ${n}`)
      creating.add(candidate)
      try {
        await mkdir(candidate)
        dir = candidate
      } catch (error) {
        creating.delete(candidate)
        if (error.code !== 'EEXIST') throw error
      }
    }
    try {
      await writeMeta(dir, {
        id,
        name: typeof name === 'string' && name.trim() ? name : basename(dir),
        color: typeof color === 'string' && COLOUR.test(color) ? color.toLowerCase() : PLANETS[projects.size % PLANETS.length],
        created: new Date().toISOString(),
        createdBy: actor?.id ?? createdBy,
      })
    } finally {
      creating.delete(dir)
    }
    await rescan(true, actor)
    const project = projects.get(id)
    if (!project) throw new Error(`The new project ${id} in ${dir} wasn't found again`)
    return infoOf(project)
  }

  /** The files in a project's tree, `.nebula/`'s own (project.json, workspace.json) included, and their bytes. */
  async function usageOf(project) {
    const usage = { bytes: 0, files: 0 }
    for (const entry of await listTree(project)) {
      if (entry.type !== 'file') continue
      usage.files += 1
      usage.bytes += entry.size
    }
    if ((await ownMetaDir(project.dir)) === true) {
      for (const item of await readdir(join(project.dir, '.nebula'), { withFileTypes: true }).catch(() => [])) {
        if (!item.isFile() || item.name.startsWith('.')) continue
        const st = await lstat(join(project.dir, '.nebula', item.name)).catch(() => null)
        if (!st?.isFile()) continue
        usage.files += 1
        usage.bytes += st.size
      }
    }
    return usage
  }

  /** A disk's refusal becomes one a person can be told (read-only, permission, disk full). */
  const named = (method) => async (...args) => {
    try {
      return await method(...args)
    } catch (error) {
      if (error instanceof BackendError) throw error
      throw fsProblem(error) ?? error
    }
  }

  return {
    capabilities: { otherWriters: true, durableHistory: false, createProject: projectsDirs.length > 0, versions: false, removeProject: false },
    createProject: named(createProject),
    listProjects: named(async ({ actor } = {}) => {
      await rescan(true, actor)
      return [...projects.values()].map(infoOf)
    }),
    project: named(async (id, { actor } = {}) => infoOf(await projectOf(id, actor))),
    cursor: named(async (id) => (await projectOf(id)).cursor),
    list: named(async (id) => {
      const project = await projectOf(id)
      return (await listTree(project)).map((entry) => project.authors.of(entry))
    }),
    stat: named(stat),
    read: named(read),
    write: named(write),
    mkdir: named(makeDir),
    rename: named(move),
    remove: named(remove),
    changesSince: named(changesSince),
    subscribe: named(subscribe),
    recent: named(async (query = {}) => recentPage(history.records, query)),
    usage: named(async (id) => {
      if (id !== undefined) return usageOf(await projectOf(id))
      await rescan(false)
      const usage = { bytes: 0, files: 0 }
      for (const project of projects.values()) {
        const each = await usageOf(project)
        usage.bytes += each.bytes
        usage.files += each.files
      }
      return usage
    }),
    close() {
      for (const project of projects.values()) project.close()
    },
  }
}
