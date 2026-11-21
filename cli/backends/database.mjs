// The database backend: one workspace's projects with the tree, every revision's place and the
// change log in one SQLite file, and each file's bytes in a byte store of objects that never change
// (cli/bytes/store.mjs: a folder here, the Suite's sealed bucket there). It is the memory backend's
// shape made durable: an entry per file or folder with an id that follows it through renames and a
// revision that rises on every write, versions `<entry id>:<rev>`, a rename as one transaction over
// the rows, and the log as the feed, whose cursors survive restarts. Only Nebula writes here, so
// every change has its actor. cli/backend.mjs has the interface and what every backend
// guarantees.
//
// node:sqlite is loaded only when this backend is made, so the folder backend still runs on Node 20.
import { createRequire } from 'node:module'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  BackendError,
  ID_PATTERN,
  META_MAX,
  META_PATH,
  PLANETS,
  changeRecord,
  checkMeta,
  hasProjectId,
  isInside,
  newProjectId,
  projectInfoOf,
  refuseOwnMove,
  refuseOwnRemove,
  servedSegments,
} from '../backend.mjs'
import { createFolderByteStore } from '../bytes/folder.mjs'

/** The version of the schema below, in the file's `user_version`. */
export const SCHEMA_VERSION = 2
/** 'NBDB' in the file's header (`application_id`), so a database that isn't Nebula's is never written. */
const APPLICATION_ID = 0x4e424442
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const COLOUR = /^#[0-9a-f]{6}$/i
const encoder = new TextEncoder()

// One table per kind of record. Entries keep an id that follows them through renames (never reused:
// AUTOINCREMENT) and a revision; a file's row names the object holding its bytes. Changes are the
// log and the feed: `id` is the log's own order across projects (`recent`'s `next`), `seq` the
// project's (the cursor's). A write's row is also a version of its file: the entry and revision it
// made (`entry`, `rev`, so a file's history follows it through renames), its bytes (`object`, `size`,
// `sha256`), the version it brought back (`restored_from`), and when thinning stopped keeping it
// (`dropped`; the row itself stays, so the log is whole). `released` names the objects a change
// stopped pointing at (an overwrite, a remove), with the entry and the path it had then, so a deleted
// file's history can be found by its last path. A project removed on purpose keeps its row and its
// entries until the sweep purges it (`removed`, `removed_by`, `purged`); its id is never reused.
//
// Schema 1 (2.0.3) had no `entry`, `rev`, `size`, `sha256`, `restored_from` or `dropped` on changes,
// no `entry` or `path` on released, and no removal on projects: MIGRATIONS[1] adds them.
const SCHEMA = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  epoch TEXT NOT NULL,
  seq INTEGER NOT NULL,
  removed TEXT,
  removed_by TEXT,
  purged TEXT
) STRICT;
CREATE TABLE entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL REFERENCES projects (id),
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'dir')),
  object TEXT,
  size INTEGER,
  sha256 TEXT,
  rev INTEGER NOT NULL,
  modified INTEGER NOT NULL,
  modified_by TEXT,
  UNIQUE (project, path)
) STRICT;
CREATE INDEX entries_object ON entries (object) WHERE object IS NOT NULL;
CREATE TABLE changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL REFERENCES projects (id),
  seq INTEGER NOT NULL,
  epoch TEXT NOT NULL,
  at TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('write', 'mkdir', 'remove', 'rename')),
  path TEXT,
  from_path TEXT,
  to_path TEXT,
  actor TEXT,
  context TEXT,
  client TEXT,
  object TEXT,
  entry INTEGER,
  rev INTEGER,
  size INTEGER,
  sha256 TEXT,
  restored_from TEXT,
  dropped TEXT,
  UNIQUE (project, seq)
) STRICT;
CREATE INDEX changes_project ON changes (project, id);
CREATE INDEX changes_object ON changes (object) WHERE object IS NOT NULL;
CREATE INDEX changes_entry ON changes (entry, rev) WHERE entry IS NOT NULL;
CREATE INDEX changes_path ON changes (project, path) WHERE path IS NOT NULL;
CREATE TABLE released (
  change INTEGER NOT NULL REFERENCES changes (id),
  object TEXT NOT NULL,
  entry INTEGER,
  path TEXT
) STRICT;
CREATE INDEX released_object ON released (object);
CREATE INDEX released_entry ON released (entry) WHERE entry IS NOT NULL;
CREATE INDEX released_path ON released (path) WHERE path IS NOT NULL;
`

/**
 * From each schema to the next, run inside one transaction after a whole copy of the file is taken
 * beside it. Each adds columns and fills in what the log already knows; none removes anything.
 */
const MIGRATIONS = {
  1: (db) => {
    db.exec(`
      ALTER TABLE projects ADD COLUMN removed TEXT;
      ALTER TABLE projects ADD COLUMN removed_by TEXT;
      ALTER TABLE projects ADD COLUMN purged TEXT;
      ALTER TABLE changes ADD COLUMN entry INTEGER;
      ALTER TABLE changes ADD COLUMN rev INTEGER;
      ALTER TABLE changes ADD COLUMN size INTEGER;
      ALTER TABLE changes ADD COLUMN sha256 TEXT;
      ALTER TABLE changes ADD COLUMN restored_from TEXT;
      ALTER TABLE changes ADD COLUMN dropped TEXT;
      ALTER TABLE released ADD COLUMN entry INTEGER;
      ALTER TABLE released ADD COLUMN path TEXT;
      CREATE INDEX changes_entry ON changes (entry, rev) WHERE entry IS NOT NULL;
      CREATE INDEX released_entry ON released (entry) WHERE entry IS NOT NULL;
      CREATE INDEX changes_path ON changes (project, path) WHERE path IS NOT NULL;
      CREATE INDEX released_path ON released (path) WHERE path IS NOT NULL;
    `)
    backfillHistory(db)
  },
}

/**
 * Gives schema 1's writes the entry and revision they made, by replaying each project's log from its
 * start: the log is whole, files are made only by writes, and a revision rises by one per write, so
 * following writes, renames and removes in order names every file's line of versions. A line still
 * in the tree takes its entry's id, once its path and revision agree with the entry's row; one that
 * doesn't agree is left unnamed (its writes keep 2.0.3's rule: kept 14 days, never listed). A line a
 * remove ended takes a new id past every id the entries have used, so a deleted file's versions can
 * be listed and restored too. Releases get the entry and path they let go. The current versions'
 * size and hash come from their entries; the rest are filled in when first needed.
 */
function backfillHistory(db) {
  const entryRow = db.prepare("SELECT id, rev FROM entries WHERE project = ? AND path = ? AND kind = 'file'")
  const setVersion = db.prepare('UPDATE changes SET entry = ?, rev = ? WHERE id = ?')
  const setReleased = db.prepare('UPDATE released SET entry = ?, path = ? WHERE change = ? AND object = ?')
  const setWriteReleased = db.prepare('UPDATE released SET entry = ?, path = ? WHERE change = ?')
  let next = Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'entries'").get()?.seq ?? 0)
  const taken = next
  for (const { id: project } of db.prepare('SELECT id FROM projects ORDER BY id').all()) {
    /** path → a line of versions: { rev, object, rows: [[change, rev]], releases: [[change, object | 'write', path]] } */
    const lines = new Map()
    const ended = []
    // createProject makes project.json at revision 1 without a change.
    lines.set(META_PATH, { rev: 1, object: null, rows: [], releases: [] })
    for (const change of db.prepare('SELECT id, type, path, from_path, to_path, object FROM changes WHERE project = ? ORDER BY seq').iterate(project)) {
      if (change.type === 'write') {
        let line = lines.get(change.path)
        if (!line) lines.set(change.path, (line = { rev: 0, object: null, rows: [], releases: [] }))
        else line.releases.push([change.id, 'write', change.path])
        line.rev += 1
        line.object = change.object
        line.rows.push([change.id, line.rev])
      } else if (change.type === 'rename') {
        const moved = [...lines].filter(([path]) => isInside(path, change.from_path))
        for (const [path] of moved) lines.delete(path)
        for (const [path, line] of moved) lines.set(change.to_path + path.slice(change.from_path.length), line)
      } else if (change.type === 'remove') {
        for (const [path, line] of [...lines]) {
          if (!isInside(path, change.path)) continue
          lines.delete(path)
          if (line.object) line.releases.push([change.id, line.object, path])
          ended.push(line)
        }
      }
    }
    const name = (line, entry) => {
      for (const [change, rev] of line.rows) setVersion.run(entry, rev, change)
      for (const [change, object, path] of line.releases) {
        // A write lets go of one object, the line's previous one; a remove names each line's own.
        if (object === 'write') setWriteReleased.run(entry, path, change)
        else setReleased.run(entry, path, change, object)
      }
    }
    for (const [path, line] of lines) {
      const row = entryRow.get(project, path)
      if (row && row.rev === line.rev && row.id <= taken) name(line, row.id)
    }
    for (const line of ended) if (line.rows.length) name(line, (next += 1))
  }
  if (next > taken) db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'entries'").run(next)
  db.exec('UPDATE changes SET size = entries.size, sha256 = entries.sha256 FROM entries WHERE changes.entry = entries.id AND changes.rev = entries.rev')
}

// --- node:sqlite, loaded on first use -------------------------------------------------------------

const QUIETED = Symbol.for('nebula.quietSqliteWarning')

/**
 * Node warns "SQLite is an experimental feature and might change at any time" when node:sqlite
 * loads, on stderr, every run. As Orbit does (ss-orbit `src/quiet-sqlite-warning.ts`), this drops
 * exactly that one warning and lets every other through. Node emits a warning's event on the next
 * tick, after the code that loaded node:sqlite has run, so the filter sits on `process.emit`: it
 * holds whenever node:sqlite is loaded, as long as it is in place first. Installed once.
 */
function quietSqliteWarning() {
  if (process[QUIETED]) return
  process[QUIETED] = true
  const emit = process.emit
  process.emit = function nebulaEmit(name, warning, ...rest) {
    if (name === 'warning' && warning instanceof Error && warning.name === 'ExperimentalWarning' && /^SQLite is an experimental feature/.test(warning.message)) return false
    return emit.call(this, name, warning, ...rest)
  }
}

/** node:sqlite, or a plain refusal on a Node that doesn't have it without a flag (22.13, 23.4). */
function loadSqlite() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 13) || (major === 23 && minor < 4)) {
    throw new Error(`Nebula's database backend needs Node 22.13 or later, for node:sqlite; this is Node ${process.versions.node}. Folders (nebula run --projects) still run on Node 20.`)
  }
  quietSqliteWarning()
  return createRequire(import.meta.url)('node:sqlite')
}

/** SQLite's refusal, in words for whoever is using Nebula, or null for any other error. */
function sqliteProblem(error) {
  if (error?.code !== 'ERR_SQLITE_ERROR') return null
  switch (error.errcode & 0xff) {
    case 13: // SQLITE_FULL
      return new BackendError('disk-full', "The disk is full, so that couldn't be saved")
    case 8: // SQLITE_READONLY
      return new BackendError('read-only', "The workspace's database can't be written just now")
    case 5: // SQLITE_BUSY
    case 6: // SQLITE_LOCKED
      return new BackendError('busy', 'The workspace is busy; try again in a moment')
    default:
      return null
  }
}

// --- the backend ----------------------------------------------------------------------------------

const nameOf = (path) => path.slice(path.lastIndexOf('/') + 1)
const parentsOf = (path) => {
  const parts = path.split('/')
  return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join('/'))
}
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
const versionOf = (row) => `${row.id.toString(36)}:${row.rev}`

function entryOf(row) {
  if (row.kind === 'dir') return { path: row.path, name: nameOf(row.path), type: 'dir' }
  const entry = { path: row.path, name: nameOf(row.path), type: 'file', size: row.size, modified: row.modified }
  if (row.modified_by) entry.modifiedBy = JSON.parse(row.modified_by)
  return entry
}

function recordOf(row) {
  const change = row.type === 'rename' ? { type: 'rename', from: row.from_path, to: row.to_path } : { type: row.type, path: row.path }
  return changeRecord({
    seq: row.seq,
    cursor: `${row.epoch}:${row.seq}`,
    project: row.project,
    change,
    actor: row.actor ? JSON.parse(row.actor) : undefined,
    context: row.context ?? undefined,
    client: row.client ?? undefined,
    restoredFrom: row.restored_from ?? undefined,
    at: new Date(row.at),
  })
}

/**
 * The database backend over one workspace: `file` is its SQLite database and `bytes` its byte
 * store, which no other workspace shares (the sweep removes every object this database doesn't
 * name). `folder` is the short way: `<folder>/nebula.db` and a folder byte store in `<folder>/bytes`.
 * Run one per workspace, in one process: subscribers hear the changes made through this backend.
 * `restored` gives every project a new epoch, for a database put back from a backup, so a client
 * holding a cursor from the history the backup lost lists again rather than missing changes.
 * `keepDays` is how long history is kept (the sweep's default, and how long a removed project can
 * come back); `clock` gives the time in milliseconds for every change, so a probe can simulate days.
 * @param {{ folder?: string, file?: string, bytes?: import('../bytes/store.mjs').ByteStore, createdBy?: string, maxBytes?: number, restored?: boolean, keepDays?: number, clock?: () => number, log?: (message: string) => void }} [options]
 * @returns {import('../backend.mjs').ProjectBackend & Required<Pick<import('../backend.mjs').ProjectBackend, 'createProject' | 'usage' | 'versions' | 'readVersion' | 'restore' | 'removeProject' | 'removedProjects' | 'restoreProject'>> & { sweep: (options?: { now?: number, keepDays?: number, graceMinutes?: number }) => Promise<{ removed: string[], kept: number, freed: number, temporary: number, dropped: number, purged: string[] }>, backup: (path: string) => Promise<void>, readOnly: boolean, file: string }}
 */
export function createDatabaseBackend({ folder, file = folder && join(folder, 'nebula.db'), bytes = folder && createFolderByteStore({ root: join(folder, 'bytes') }), createdBy = 'nebula-server', maxBytes = Infinity, restored = false, keepDays = 14, clock = Date.now, log = () => {} } = {}) {
  if (!file || !bytes) throw new Error('createDatabaseBackend needs a folder, or a file and a byte store')
  const sqlite = loadSqlite()
  mkdirSync(dirname(file), { recursive: true })
  const { db, readOnly } = openDatabase(sqlite, file, log, clock)
  if (restored && !readOnly) {
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const { id } of db.prepare('SELECT id FROM projects').all()) db.prepare('UPDATE projects SET epoch = ? WHERE id = ?').run(newEpoch(), id)
      db.exec('COMMIT')
    } catch (error) {
      rollback(db)
      throw error
    }
  }

  const sql = {
    project: db.prepare('SELECT * FROM projects WHERE id = ?'),
    projects: db.prepare('SELECT * FROM projects WHERE removed IS NULL ORDER BY position, id'),
    // Removed projects: those still restorable, newest removal first; marking one removed or back
    // (back under a new epoch, so a cursor from before resyncs); and the purge's three steps.
    removedProjects: db.prepare('SELECT * FROM projects WHERE removed IS NOT NULL AND purged IS NULL ORDER BY removed DESC, id'),
    markRemoved: db.prepare('UPDATE projects SET removed = ?, removed_by = ? WHERE id = ?'),
    markBack: db.prepare('UPDATE projects SET removed = NULL, removed_by = NULL, epoch = ? WHERE id = ?'),
    due: db.prepare('SELECT id FROM projects WHERE removed IS NOT NULL AND purged IS NULL AND removed < ?'),
    dropProjectVersions: db.prepare("UPDATE changes SET dropped = ? WHERE project = ? AND type = 'write' AND dropped IS NULL"),
    dropProjectEntries: db.prepare('DELETE FROM entries WHERE project = ?'),
    markPurged: db.prepare('UPDATE projects SET purged = ? WHERE id = ?'),
    nextPosition: db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS position FROM projects'),
    addProject: db.prepare('INSERT INTO projects (id, position, epoch, seq) VALUES (?, ?, ?, 0)'),
    setSeq: db.prepare('UPDATE projects SET seq = ? WHERE id = ?'),
    entry: db.prepare('SELECT * FROM entries WHERE project = ? AND path = ?'),
    entries: db.prepare("SELECT * FROM entries WHERE project = ? AND path <> '.nebula' AND substr(path, 1, 8) <> '.nebula/'"),
    addEntry: db.prepare('INSERT INTO entries (project, path, kind, object, size, sha256, rev, modified, modified_by) VALUES (:project, :path, :kind, :object, :size, :sha256, 1, :modified, :modifiedBy)'),
    rewrite: db.prepare('UPDATE entries SET object = :object, size = :size, sha256 = :sha256, rev = rev + 1, modified = :modified, modified_by = :modifiedBy WHERE id = :id'),
    // A folder's rows by prefix without LIKE, whose wildcards a path can hold: the path itself, or
    // one that starts with it and a '/', measured in SQLite's own characters.
    under: db.prepare('SELECT id, path, object FROM entries WHERE project = :project AND (path = :path OR substr(path, 1, length(:prefix)) = :prefix)'),
    move: db.prepare('UPDATE entries SET path = :to || substr(path, length(:from) + 1) WHERE project = :project AND (path = :from OR substr(path, 1, length(:prefix)) = :prefix)'),
    drop: db.prepare('DELETE FROM entries WHERE project = :project AND (path = :path OR substr(path, 1, length(:prefix)) = :prefix)'),
    addChange: db.prepare('INSERT INTO changes (project, seq, epoch, at, type, path, from_path, to_path, actor, context, client, object, entry, rev, size, sha256, restored_from) VALUES (:project, :seq, :epoch, :at, :type, :path, :from, :to, :actor, :context, :client, :object, :entry, :rev, :size, :sha256, :restoredFrom)'),
    release: db.prepare('INSERT INTO released (change, object, entry, path) VALUES (?, ?, ?, ?)'),
    since: db.prepare('SELECT * FROM changes WHERE project = ? AND seq > ? ORDER BY seq'),
    // History: an entry by id wherever it is, a file's versions newest first, one version, the
    // newest revision an entry ever had, and what last was at a path that's empty now (a write
    // there, or a remove that let it go).
    entryById: db.prepare('SELECT * FROM entries WHERE id = ?'),
    addEntryAs: db.prepare('INSERT INTO entries (id, project, path, kind, object, size, sha256, rev, modified, modified_by) VALUES (:id, :project, :path, :kind, :object, :size, :sha256, :rev, :modified, :modifiedBy)'),
    versionsOf: db.prepare("SELECT * FROM changes WHERE project = :project AND entry = :entry AND type = 'write' AND rev < :before AND (dropped IS NULL OR rev = :current) ORDER BY rev DESC LIMIT :limit"),
    version: db.prepare("SELECT * FROM changes WHERE project = ? AND entry = ? AND rev = ? AND type = 'write'"),
    lastRev: db.prepare("SELECT COALESCE(MAX(rev), 0) AS rev FROM changes WHERE entry = ? AND type = 'write'"),
    lastWrittenAt: db.prepare("SELECT id AS change, entry FROM changes WHERE project = ? AND path = ? AND type = 'write' AND entry IS NOT NULL ORDER BY id DESC LIMIT 1"),
    lastRemovedAt: db.prepare("SELECT released.change, released.entry FROM released JOIN changes ON changes.id = released.change WHERE changes.project = ? AND released.path = ? AND changes.type = 'remove' AND released.entry IS NOT NULL ORDER BY released.change DESC LIMIT 1"),
    // Deleted files: what each remove let go (newest first), and the last version an entry had.
    removedFiles: db.prepare("SELECT released.entry, released.path, changes.at, changes.actor FROM released JOIN changes ON changes.id = released.change WHERE changes.project = ? AND changes.type = 'remove' AND changes.at >= ? AND released.entry IS NOT NULL AND released.path IS NOT NULL ORDER BY released.change DESC, released.path"),
    lastWrite: db.prepare("SELECT * FROM changes WHERE project = ? AND entry = ? AND type = 'write' ORDER BY rev DESC LIMIT 1"),
    measured: db.prepare('UPDATE changes SET size = ?, sha256 = ? WHERE object = ? AND size IS NULL'),
    // A removed project's files aren't counted: removing a project makes room at once.
    usage: db.prepare("SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM entries WHERE kind = 'file' AND project IN (SELECT id FROM projects WHERE removed IS NULL)"),
    projectUsage: db.prepare("SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM entries WHERE kind = 'file' AND project = ?"),
    // An object the sweep must keep: an entry points at it, or a version thinning still keeps names
    // it. A write whose file couldn't be named (2.0.3's, see backfillHistory), and an object no
    // version names (project.json as its project was made), keep 2.0.3's rule: kept while a change
    // in the last keepDays put it in place or let it go.
    used: db.prepare(`SELECT EXISTS (SELECT 1 FROM entries WHERE object = :id)
      OR EXISTS (SELECT 1 FROM changes WHERE object = :id AND dropped IS NULL AND (entry IS NOT NULL OR at >= :cutoff))
      OR (EXISTS (SELECT 1 FROM released JOIN changes ON changes.id = released.change WHERE released.object = :id AND changes.at >= :cutoff)
        AND NOT EXISTS (SELECT 1 FROM changes WHERE object = :id AND entry IS NOT NULL)) AS used`),
    // Thinning: every version still kept, by file, and what ended each (the first change after it
    // that let its entry's bytes go: an overwrite, a restore over it, or a remove).
    keptVersions: db.prepare("SELECT id, project, entry, rev, at, actor FROM changes WHERE type = 'write' AND entry IS NOT NULL AND dropped IS NULL ORDER BY entry, rev"),
    endOf: db.prepare('SELECT changes.at, changes.type, changes.actor, changes.restored_from FROM released JOIN changes ON changes.id = released.change WHERE released.entry = ? AND released.change > ? ORDER BY released.change LIMIT 1'),
    dropVersion: db.prepare('UPDATE changes SET dropped = ? WHERE id = ? AND dropped IS NULL'),
  }
  const recentQueries = new Map()
  /** project id → its live subscribers. */
  const subscribers = new Map()
  /** object id → project.json's parsed content: an object never changes, so this never goes stale. */
  const metaCache = new Map()
  let closed = false

  function writable() {
    if (readOnly) throw new BackendError('read-only', `This workspace's database was written by a newer Nebula, so this one only reads it`)
  }

  /** Runs `action` as one transaction, taking the write lock at the start (BEGIN IMMEDIATE), so its
   * checks and its changes are one step for every process on the file. `action` never waits. */
  function transaction(action) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      db.exec('COMMIT')
      return result
    } catch (error) {
      rollback(db)
      throw error
    }
  }

  /** The project's row; a removed one only when `removed` says it may be (its removal and restore). */
  function projectRow(id, { removed = false } = {}) {
    const row = typeof id === 'string' ? sql.project.get(id) : undefined
    if (!row || row.purged || (row.removed && !removed)) throw new BackendError('no-project', `No project ${JSON.stringify(id)} here`)
    return row
  }

  async function textOf(object) {
    return new Response(await bytes.get(object)).text()
  }

  /** The project's info from its own `.nebula/project.json`, whatever has been written there. */
  async function infoOf(row) {
    let meta = {}
    const file = sql.entry.get(row.id, META_PATH)
    if (file?.kind === 'file') {
      if (!metaCache.has(file.object)) {
        let parsed = {}
        try {
          parsed = JSON.parse(await textOf(file.object))
        } catch {
          parsed = {}
        }
        metaCache.set(file.object, parsed)
      }
      meta = metaCache.get(file.object)
    }
    return projectInfoOf({ ...meta, id: row.id }, { name: row.id, color: PLANETS[row.position % PLANETS.length], createdBy })
  }

  /** Where a path stands: a file on the way (`blocked`), or a missing folder on the way (`missing`). */
  function standing(id, path) {
    for (const parent of parentsOf(path)) {
      const row = sql.entry.get(id, parent)
      if (!row) return { missing: true }
      if (row.kind !== 'dir') return { blocked: true }
    }
    return {}
  }

  function makeParents(id, path, now) {
    for (const parent of parentsOf(path)) {
      if (!sql.entry.get(id, parent)) sql.addEntry.run({ project: id, path: parent, kind: 'dir', object: null, size: null, sha256: null, modified: now, modifiedBy: null })
    }
  }

  /** Appends a change to the log, inside the caller's transaction; returns its record. A write
   * passes the version it made (`version`: its entry row, which holds the object, revision, size and
   * hash, and `restoredFrom`); `released` lists what it let go, as `{ object, entry, path }`. */
  function append(id, change, author, { version = null, restoredFrom = null, released = [], at = new Date(clock()) } = {}) {
    const row = projectRow(id, { removed: true })
    const seq = row.seq + 1
    sql.setSeq.run(seq, id)
    const { lastInsertRowid } = sql.addChange.run({
      project: id,
      seq,
      epoch: row.epoch,
      at: at.toISOString(),
      type: change.type,
      path: change.path ?? null,
      from: change.from ?? null,
      to: change.to ?? null,
      actor: author.actor ? JSON.stringify(author.actor) : null,
      context: author.context ?? null,
      client: author.client ?? null,
      object: version?.object ?? null,
      entry: version?.id ?? null,
      rev: version?.rev ?? null,
      size: version?.size ?? null,
      sha256: version?.sha256 ?? null,
      restoredFrom,
    })
    // One row for each file let go, though two hold the same bytes: a removed folder's files are
    // each found by their own row (deletedFiles), and each one's version ends with it (thinning).
    const seen = new Set()
    for (const each of released) {
      const key = `${each.entry ?? ''}:${each.object}`
      if (!each.object || seen.has(key)) continue
      seen.add(key)
      sql.release.run(lastInsertRowid, each.object, each.entry ?? null, each.path ?? null)
    }
    return changeRecord({ seq, cursor: `${row.epoch}:${seq}`, project: id, change, actor: author.actor, context: author.context, client: author.client, restoredFrom: restoredFrom ?? undefined, at })
  }

  /** Tells the project's subscribers, once the change is committed. */
  function tell(record) {
    for (const subscriber of subscribers.get(record.project) ?? []) subscriber.change(record)
  }

  const cursorOf = (row) => `${row.epoch}:${row.seq}`

  async function createProject({ id, name, color } = {}, { actor } = {}) {
    writable()
    if (id !== undefined && (!hasProjectId({ id }) || !ID_PATTERN.test(id))) throw new BackendError('invalid-path', `${JSON.stringify(id)} isn't a project id`)
    if (id !== undefined && sql.project.get(id)) throw new BackendError('exists', `A project ${JSON.stringify(id)} is here already`)
    while (id === undefined) {
      const made = newProjectId(randomBytes)
      if (!sql.project.get(made)) id = made
    }
    const { position } = sql.nextPosition.get()
    const meta = {
      id,
      name: typeof name === 'string' && name.trim() ? name : id,
      color: typeof color === 'string' && COLOUR.test(color) ? color.toLowerCase() : PLANETS[position % PLANETS.length],
      created: new Date(clock()).toISOString(),
      createdBy: actor?.id ?? createdBy,
    }
    // The project's identity lives in its own tree, as in every other place it can be.
    const put = await bytes.put([encoder.encode(`${JSON.stringify(meta, null, 2)}\n`)])
    transaction(() => {
      if (sql.project.get(id)) throw new BackendError('exists', `A project ${JSON.stringify(id)} is here already`)
      const now = clock()
      sql.addProject.run(id, sql.nextPosition.get().position, newEpoch())
      sql.addEntry.run({ project: id, path: '.nebula', kind: 'dir', object: null, size: null, sha256: null, modified: now, modifiedBy: null })
      sql.addEntry.run({ project: id, path: META_PATH, kind: 'file', object: put.id, size: put.size, sha256: put.sha256, modified: now, modifiedBy: actor ? JSON.stringify(actor) : null })
    })
    return infoOf(projectRow(id))
  }

  async function write(id, path, body, { ifMatch, ifAbsent = false, parents = true, ...author } = {}) {
    writable()
    projectRow(id)
    servedSegments(path)
    // The bytes first, whole and durable, under a name nothing points at yet.
    const put = await bytes.put(body, { maxBytes: path === META_PATH ? META_MAX : maxBytes })
    if (path === META_PATH) checkMeta(await textOf(put.id), put.size, id)
    // Then one transaction: check, make the parents, point the entry, append the change. A refusal
    // here leaves the object for the sweep.
    const { record, row, cursor } = transaction(() => {
      projectRow(id)
      const at = standing(id, path)
      if (at.blocked) throw new BackendError('type', `${JSON.stringify(path)} goes through a file`, { expected: 'folder' })
      if (at.missing && !parents) throw new BackendError('not-found', `The folder for ${JSON.stringify(path)} is gone`)
      const existing = sql.entry.get(id, path)
      if (ifAbsent) {
        if (existing) throw new BackendError('precondition', `Something already exists at ${JSON.stringify(path)}`, { exists: true })
      } else if (ifMatch) {
        if (!existing || existing.kind !== 'file') throw new BackendError('precondition', `${JSON.stringify(path)} is gone, or isn't a file`, { absent: true })
        if (versionOf(existing) !== ifMatch) throw new BackendError('precondition', `${JSON.stringify(path)} changed`, { absent: false })
      }
      if (existing && existing.kind !== 'file') throw new BackendError('type', `${JSON.stringify(path)} is a folder`, { expected: 'file' })
      // The same bytes as the file now: nothing to keep, so no revision and no record, and the
      // answer is the current version. The object just put is left for the sweep.
      if (existing && existing.sha256 === put.sha256) return { record: null, row: existing, cursor: cursorOf(projectRow(id)) }
      const now = clock()
      makeParents(id, path, now)
      const fields = { object: put.id, size: put.size, sha256: put.sha256, modified: now, modifiedBy: author.actor ? JSON.stringify(author.actor) : null }
      // The same file, a new revision: a reader holding the old object keeps it whole.
      if (existing) sql.rewrite.run({ ...fields, id: existing.id })
      else sql.addEntry.run({ ...fields, project: id, path, kind: 'file' })
      const row = sql.entry.get(id, path)
      const released = existing ? [{ object: existing.object, entry: existing.id, path }] : []
      const record = append(id, { type: 'write', path }, author, { version: row, released, at: new Date(now) })
      return { record, row, cursor: record.cursor }
    })
    if (record) tell(record)
    return { entry: entryOf(row), version: versionOf(row), cursor }
  }

  async function makeDir(id, path, author = {}) {
    writable()
    projectRow(id)
    servedSegments(path)
    const result = transaction(() => {
      const at = standing(id, path)
      if (at.blocked) throw new BackendError('type', `${JSON.stringify(path)} goes through a file`, { expected: 'folder' })
      const existing = sql.entry.get(id, path)
      if (existing) {
        if (existing.kind !== 'dir') throw new BackendError('type', `${JSON.stringify(path)} is a file`, { expected: 'folder' })
        return { changed: false, cursor: cursorOf(projectRow(id)) }
      }
      const now = clock()
      makeParents(id, path, now)
      sql.addEntry.run({ project: id, path, kind: 'dir', object: null, size: null, sha256: null, modified: now, modifiedBy: null })
      return { changed: true, record: append(id, { type: 'mkdir', path }, author) }
    })
    if (!result.changed) return result
    tell(result.record)
    return { changed: true, cursor: result.record.cursor }
  }

  async function move(id, from, to, author = {}) {
    writable()
    projectRow(id)
    servedSegments(from)
    servedSegments(to)
    refuseOwnMove(from, to)
    const record = transaction(() => {
      if (!sql.entry.get(id, from) || standing(id, from).blocked) throw new BackendError('not-found', `Nothing exists at ${JSON.stringify(from)}`)
      if (sql.entry.get(id, to) || from === to) throw new BackendError('exists', `Something already exists at ${JSON.stringify(to)}`)
      if (standing(id, to).blocked) throw new BackendError('type', `${JSON.stringify(to)} goes through a file`, { expected: 'folder' })
      if (isInside(to, from)) throw new BackendError('into-itself', `A folder can't move into itself`)
      makeParents(id, to, clock())
      // One statement over the rows: each keeps its id and revision, so its version follows it.
      sql.move.run({ project: id, from, to, prefix: `${from}/` })
      return append(id, { type: 'rename', from, to }, author)
    })
    tell(record)
    return { cursor: record.cursor }
  }

  async function remove(id, path, author = {}) {
    writable()
    projectRow(id)
    servedSegments(path)
    refuseOwnRemove(path)
    const record = transaction(() => {
      if (!sql.entry.get(id, path) || standing(id, path).blocked) throw new BackendError('not-found', `Nothing exists at ${JSON.stringify(path)}`)
      const where = { project: id, path, prefix: `${path}/` }
      const released = sql.under.all(where).map((row) => ({ object: row.object, entry: row.id, path: row.path }))
      sql.drop.run(where)
      // The objects stay, named by this change, until the sweep: a removed file can come back.
      return append(id, { type: 'remove', path }, author, { released })
    })
    tell(record)
    return { cursor: record.cursor }
  }

  async function read(id, path) {
    projectRow(id)
    servedSegments(path)
    const row = sql.entry.get(id, path)
    if (!row) throw new BackendError('not-found', `Nothing exists at ${JSON.stringify(path)}`)
    if (row.kind !== 'file') throw new BackendError('type', `${JSON.stringify(path)} is a folder`, { expected: 'file' })
    // This revision's object never changes, so the stream is the file as it was now.
    const body = await bytes.get(row.object)
    return { body, size: row.size, version: versionOf(row), entry: entryOf(row) }
  }

  async function changesSince(id, since) {
    const row = projectRow(id)
    const text = String(since ?? '')
    const split = text.lastIndexOf(':')
    const seq = Number(text.slice(split + 1))
    if (split < 0 || text.slice(0, split) !== row.epoch || !Number.isInteger(seq) || seq < 0 || seq > row.seq) return { cursor: cursorOf(row), resync: true }
    // The whole log is kept, so within an epoch a cursor is never too old, across restarts too.
    return { cursor: cursorOf(row), changes: sql.since.all(id, seq).map(recordOf) }
  }

  /** The newest changes first by the log's own order; `next` is the last one's row id. */
  async function recent({ project, path, limit = 50, before } = {}) {
    const until = before === undefined || before === null || before === '' ? Number.MAX_SAFE_INTEGER : Number(before)
    if (!Number.isSafeInteger(until)) return { changes: [], next: null }
    const key = `${project ? 'p' : ''}${path ? 't' : ''}`
    if (!recentQueries.has(key)) {
      const at = (column) => `(${column} = :path OR substr(${column}, 1, length(:prefix)) = :prefix)`
      const where = ['id < :before']
      if (project) where.push('project = :project')
      if (path) where.push(`(${at('path')} OR ${at('from_path')} OR ${at('to_path')})`)
      recentQueries.set(key, db.prepare(`SELECT * FROM changes WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT :limit`))
    }
    const params = { before: until, limit }
    if (project) params.project = project
    if (path) Object.assign(params, { path, prefix: `${path}/` })
    const rows = recentQueries.get(key).all(params)
    const next = rows.length === limit && rows.length > 0 ? String(rows[rows.length - 1].id) : null
    return { changes: rows.map(recordOf), next }
  }

  // --- removed projects ------------------------------------------------------------------------

  function removedOf(info, row) {
    const removed = { id: info.id, name: info.name, color: info.color, removed: row.removed }
    if (row.removed_by) removed.removedBy = JSON.parse(row.removed_by)
    removed.purgeAfter = new Date(Date.parse(row.removed) + keepDays * DAY).toISOString()
    return removed
  }

  /**
   * Removes a project on purpose, restorably until `keepDays` after. Its row and entries stay as they
   * are; it leaves the list and answers `no-project`, and its id stays taken. The log gets a `remove`
   * with path '' (what the app already reads as "the project was removed on purpose"), told to its
   * feeds before they end, so open clients resync and drop it.
   */
  async function removeProject(id, { actor, context, client } = {}) {
    writable()
    const info = await infoOf(projectRow(id))
    const now = clock()
    const { record, row } = transaction(() => {
      projectRow(id)
      const record = append(id, { type: 'remove', path: '' }, { actor, context, client }, { at: new Date(now) })
      sql.markRemoved.run(new Date(now).toISOString(), actor ? JSON.stringify(actor) : null, id)
      return { record, row: projectRow(id, { removed: true }) }
    })
    tell(record)
    for (const subscriber of subscribers.get(id) ?? []) subscriber.end()
    subscribers.delete(id)
    return removedOf(info, row)
  }

  async function removedProjects() {
    return Promise.all(sql.removedProjects.all().map(async (row) => removedOf(await infoOf(row), row)))
  }

  /**
   * A removed project back as it was, before the sweep purges it. It takes a new epoch, so a client
   * holding a cursor from before lists it again; the log gets a `mkdir` with path '' (the project's
   * root made again; '' is never a file's path, so it can mean nothing else).
   */
  async function restoreProject(id, { actor, context, client } = {}) {
    writable()
    const row = projectRow(id, { removed: true })
    if (!row.removed) throw new BackendError('no-project', `${JSON.stringify(id)} wasn't removed`)
    const record = transaction(() => {
      if (!projectRow(id, { removed: true }).removed) throw new BackendError('no-project', `${JSON.stringify(id)} wasn't removed`)
      sql.markBack.run(newEpoch(), id)
      return append(id, { type: 'mkdir', path: '' }, { actor, context, client })
    })
    tell(record)
    return infoOf(projectRow(id))
  }

  /** Purges each project removed more than `keepDays` before `now`: its entries go and its versions
   * are dropped, so the sweep frees its bytes; its row (the id stays taken) and its log stay. */
  function purge(now, days) {
    const purged = []
    const at = new Date(now).toISOString()
    for (const { id } of sql.due.all(new Date(now - days * DAY).toISOString())) {
      transaction(() => {
        sql.dropProjectVersions.run(at, id)
        sql.dropProjectEntries.run(id)
        sql.markPurged.run(at, id)
      })
      purged.push(id)
    }
    return purged
  }

  // --- history ---------------------------------------------------------------------------------

  /** The file whose history `path` names: the file there now, or else the one last written there or
   * removed from there (a deleted file, or one moved away since). `row` is the file there now. */
  function historyOf(id, path) {
    const row = sql.entry.get(id, path)
    if (row) {
      if (row.kind !== 'file') throw new BackendError('type', `${JSON.stringify(path)} is a folder`, { expected: 'file' })
      return { entry: row.id, row }
    }
    const written = sql.lastWrittenAt.get(id, path)
    const removed = sql.lastRemovedAt.get(id, path)
    const last = !written ? removed : !removed || written.change > removed.change ? written : removed
    if (!last) throw new BackendError('not-found', `No file has been at ${JSON.stringify(path)}`)
    return { entry: last.entry, row: null }
  }

  /** A version string's entry and revision, when it names one of this file's. */
  function versionIn(history, version, path) {
    const match = /^([0-9a-z]{1,12}):([0-9]{1,15})$/.exec(String(version ?? ''))
    const entry = match ? parseInt(match[1], 36) : NaN
    if (!match || entry !== history.entry) throw new BackendError('not-found', `${JSON.stringify(version)} isn't a version of ${JSON.stringify(path)}`)
    return { entry, rev: Number(match[2]) }
  }

  /** An object's size and hash, read from the byte store (a version written before schema 2), or
   * null when the object has gone. Kept on the rows that name it, so this happens once. */
  async function measure(object) {
    let stream
    try {
      stream = await bytes.get(object)
    } catch (error) {
      if (error?.code === 'no-object') return null
      throw error
    }
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of stream) {
      hash.update(chunk)
      size += chunk.byteLength
    }
    const sha256 = hash.digest('hex')
    if (!readOnly) sql.measured.run(size, sha256, object)
    return { size, sha256 }
  }

  /** A version row as the client sees it (VersionInfo), or null when its bytes have gone. */
  async function versionInfo(row, current) {
    const size = row.size ?? (await measure(row.object))?.size
    if (size === undefined) return null
    const info = { version: `${row.entry.toString(36)}:${row.rev}`, at: row.at, size }
    if (row.actor) info.actor = JSON.parse(row.actor)
    if (row.context) info.context = row.context
    info.current = current
    info.path = row.path
    if (row.restored_from) info.restoredFrom = row.restored_from
    return info
  }

  async function versions(id, path, { limit = 50, before } = {}) {
    projectRow(id)
    servedSegments(path)
    const history = historyOf(id, path)
    const until = before === undefined || before === null || before === '' ? Number.MAX_SAFE_INTEGER : Number(before)
    if (!Number.isSafeInteger(until)) return { versions: [], next: null }
    const current = history.row?.rev ?? -1
    const rows = sql.versionsOf.all({ project: id, entry: history.entry, before: until, current, limit })
    const listed = []
    // A current revision with no write of its own (project.json as a project was made, or a file
    // whose 2.0.3 history couldn't be named) is still the file now, so it heads the first page.
    if (history.row && current < until && !rows.some((row) => row.rev === current)) {
      const { row } = history
      listed.push({ rev: current, info: { version: versionOf(row), at: new Date(row.modified).toISOString(), size: row.size, ...(row.modified_by ? { actor: JSON.parse(row.modified_by) } : {}), current: true, path } })
    }
    for (const row of rows) {
      const info = await versionInfo(row, row.rev === current)
      if (info) listed.push({ rev: row.rev, info })
    }
    const page = listed.slice(0, limit)
    const more = rows.length === limit || listed.length > limit
    return { versions: page.map(({ info }) => info), next: more && page.length ? String(page[page.length - 1].rev) : null }
  }

  async function readVersion(id, path, version) {
    projectRow(id)
    servedSegments(path)
    const history = historyOf(id, path)
    const { entry, rev } = versionIn(history, version, path)
    if (history.row?.rev === rev) return read(id, path)
    const row = sql.version.get(id, entry, rev)
    if (!row?.object || row.dropped) throw new BackendError('not-found', `${JSON.stringify(version)} of ${JSON.stringify(path)} is no longer kept`)
    const size = row.size ?? (await measure(row.object))?.size
    let body
    try {
      if (size === undefined) throw Object.assign(new Error('gone'), { code: 'no-object' })
      body = await bytes.get(row.object)
    } catch (error) {
      if (error?.code === 'no-object') throw new BackendError('not-found', `${JSON.stringify(version)} of ${JSON.stringify(path)} is no longer kept`)
      throw error
    }
    const shown = { path, name: nameOf(path), type: 'file', size, modified: Date.parse(row.at) }
    if (row.actor) shown.modifiedBy = JSON.parse(row.actor)
    return { body, size, version: `${entry.toString(36)}:${rev}`, entry: shown }
  }

  /**
   * The files deleted from a project that can still come back, newest delete first: each with the
   * version it had before the delete (what `restore` is given), its size, and when and by whom it
   * was deleted. A delete counts for `keepDays`, as the sweep keeps the version before it for as
   * long. A file is listed once, for its latest delete, and only while nothing is at its path (a
   * file made there again, a folder, or the file restored) and that path's history is still this
   * file's, so that Restore at that path finds it. A deleted folder lists the files in it.
   */
  async function deletedFiles(id, { limit = 200 } = {}) {
    projectRow(id)
    const cutoff = new Date(clock() - keepDays * DAY).toISOString()
    const files = []
    const seen = new Set()
    for (const gone of sql.removedFiles.all(id, cutoff)) {
      if (seen.has(gone.entry)) continue
      seen.add(gone.entry)
      if (gone.path === '.nebula' || gone.path.startsWith('.nebula/')) continue
      let history
      try {
        history = historyOf(id, gone.path)
      } catch {
        continue
      }
      if (history.row || history.entry !== gone.entry) continue
      const last = sql.lastWrite.get(id, gone.entry)
      const info = last && !last.dropped ? await versionInfo(last, false) : null
      if (!info) continue
      if (files.length === limit) return { files, more: true }
      const file = { path: gone.path, version: info.version, size: info.size, deletedAt: gone.at }
      if (gone.actor) file.deletedBy = JSON.parse(gone.actor)
      files.push(file)
    }
    return { files, more: false }
  }

  /**
   * Brings back an earlier version as a new revision: the entry points at that version's object
   * again (objects never change, so it is shared, never copied), and a write by the restorer is
   * logged with `restoredFrom`. The version it replaced stays in history (thinning keeps it). A
   * deleted file comes back under its own entry, so its history goes on; one whose entry lives on
   * at another path comes back as a new file.
   */
  async function restore(id, path, version, { ifMatch, ifAbsent = false, parents = true, ...author } = {}) {
    writable()
    projectRow(id)
    servedSegments(path)
    // Taken by any file or folder, even one that isn't this version's: 412, before the version is looked up.
    if (ifAbsent && sql.entry.get(id, path)) throw new BackendError('precondition', `Something already exists at ${JSON.stringify(path)}`, { exists: true })
    const history = historyOf(id, path)
    const { entry, rev } = versionIn(history, version, path)
    const gone = () => new BackendError('not-found', `${JSON.stringify(version)} of ${JSON.stringify(path)} is no longer kept`)
    const found = sql.version.get(id, entry, rev)
    if (!found?.object || (found.dropped && history.row?.rev !== rev)) throw gone()
    const measured = found.size !== null && found.sha256 !== null ? { size: found.size, sha256: found.sha256 } : await measure(found.object)
    if (!measured) throw gone()
    if (path === META_PATH) checkMeta(await textOf(found.object), measured.size, id)
    const { record, row, cursor } = transaction(() => {
      projectRow(id)
      const existing = sql.entry.get(id, path)
      const again = sql.version.get(id, entry, rev)
      if (!again || (again.dropped && !(existing?.id === entry && existing.rev === rev))) throw gone()
      const at = standing(id, path)
      if (at.blocked) throw new BackendError('type', `${JSON.stringify(path)} goes through a file`, { expected: 'folder' })
      if (at.missing && !parents) throw new BackendError('not-found', `The folder for ${JSON.stringify(path)} is gone`)
      if (ifAbsent) {
        if (existing) throw new BackendError('precondition', `Something already exists at ${JSON.stringify(path)}`, { exists: true })
      } else if (ifMatch) {
        if (!existing || existing.kind !== 'file') throw new BackendError('precondition', `${JSON.stringify(path)} is gone, or isn't a file`, { absent: true })
        if (versionOf(existing) !== ifMatch) throw new BackendError('precondition', `${JSON.stringify(path)} changed`, { absent: false })
      }
      if (existing && existing.kind !== 'file') throw new BackendError('type', `${JSON.stringify(path)} is a folder`, { expected: 'file' })
      // Another file took the path since its history was looked up: that version isn't this file's.
      if (existing && existing.id !== entry) throw new BackendError('precondition', `${JSON.stringify(path)} changed`, { absent: false })
      if (existing && existing.sha256 === measured.sha256) return { record: null, row: existing, cursor: cursorOf(projectRow(id)) }
      const now = clock()
      makeParents(id, path, now)
      const fields = { object: again.object, size: measured.size, sha256: measured.sha256, modified: now, modifiedBy: author.actor ? JSON.stringify(author.actor) : null }
      if (existing) sql.rewrite.run({ ...fields, id: existing.id })
      else if (!sql.entryById.get(entry)) sql.addEntryAs.run({ ...fields, id: entry, rev: sql.lastRev.get(entry).rev + 1, project: id, path, kind: 'file' })
      else sql.addEntry.run({ ...fields, project: id, path, kind: 'file' })
      const row = sql.entry.get(id, path)
      const released = existing ? [{ object: existing.object, entry: existing.id, path }] : []
      const record = append(id, { type: 'write', path }, author, { version: row, restoredFrom: `${entry.toString(36)}:${rev}`, released, at: new Date(now) })
      return { record, row, cursor: record.cursor }
    })
    if (record) tell(record)
    return { entry: entryOf(row), version: versionOf(row), cursor }
  }

  /**
   * Thins every file's history to the settled schedule, and returns how
   * many versions it dropped. Of the versions not yet dropped it keeps the current one; the version
   * that was the file at each mark of the schedule (each 10 minutes in the last hour, each hour in
   * the last day, each UTC midnight back to `keepDays`), which is the newest written in each window,
   * or the one still standing through a window with no write; and, until `keepDays` after it was
   * replaced, the version just before another actor's write (`type` and `id` compared), the one a
   * remove let go and the one a restore replaced. The marks are aligned to the clock, so a version a
   * coarser window will want later is always the newest of a finer one now: thinning hourly never
   * drops what a later run would keep. The rest are marked `dropped`; their rows stay in the log,
   * and their bytes go with the sweep. It reads outside a transaction and marks inside one: a write
   * landing between the two can only leave a version kept one run longer.
   */
  function thin(now, keepDays) {
    const horizon = now - keepDays * DAY
    const marks = new Set()
    const every = (step, span) => {
      for (let mark = Math.floor(now / step) * step; mark > now - span; mark -= step) if (mark > horizon) marks.add(mark)
    }
    every(10 * MINUTE, HOUR)
    every(HOUR, DAY)
    every(DAY, keepDays * DAY)
    const sameActor = (a, b) => {
      const x = a ? JSON.parse(a) : null
      const y = b ? JSON.parse(b) : null
      return x === null || y === null ? x === y : x.type === y.type && x.id === y.id
    }
    const drops = []
    const judge = (line) => {
      const entry = sql.entryById.get(line[0].entry)
      for (const version of line) {
        version.time = Date.parse(version.at)
        const end = sql.endOf.get(version.entry, version.id)
        version.current = !end && entry?.rev === version.rev
        version.end = end ? Date.parse(end.at) : version.current ? Infinity : null
        version.keep = version.current
        // Kept after it was replaced: before another actor's write, let go by a remove, or replaced by a restore.
        if (end && version.end >= horizon && (end.type === 'remove' || end.restored_from || !sameActor(version.actor, end.actor))) version.keep = true
        // Its end unknown (an entry gone with no remove logged): 2.0.3's rule, keepDays from its write.
        if (version.end === null && version.time >= horizon) version.keep = true
      }
      for (const mark of marks) {
        let standing = null
        for (const version of line) if (version.time < mark && (!standing || version.rev > standing.rev)) standing = version
        if (standing && standing.end !== null && standing.end >= mark) standing.keep = true
      }
      for (const version of line) if (!version.keep) drops.push(version.id)
    }
    let line = []
    for (const version of sql.keptVersions.iterate()) {
      if (line.length && line[0].entry !== version.entry) {
        judge(line)
        line = []
      }
      line.push(version)
    }
    if (line.length) judge(line)
    if (!drops.length) return 0
    const at = new Date(now).toISOString()
    return transaction(() => drops.reduce((count, id) => count + Number(sql.dropVersion.run(at, id).changes), 0))
  }

  /**
   * Thins history (`thin`), then removes the objects nothing needs any more, and says which. An
   * object goes only when no entry points at it, no version thinning keeps names it (or, for an
   * object no named version holds, no change younger than `keepDays` put it in place or let it go),
   * and it has been in the byte store longer than `graceMinutes`, so an upload whose transaction
   * hasn't committed yet is never taken. Temporary files a crash left mid-upload go too, after a day.
   * First it purges the projects removed more than `keepDays` ago (`purged`, their ids). `dropped`
   * counts the versions thinning dropped this time.
   */
  async function sweep({ now = clock(), keepDays: days = keepDays, graceMinutes = 60 } = {}) {
    writable()
    const purged = purge(now, days)
    const dropped = thin(now, days)
    const cutoff = new Date(now - days * DAY).toISOString()
    const removed = []
    let kept = 0
    let freed = 0
    for await (const object of bytes.list()) {
      if (now - object.at <= graceMinutes * MINUTE || sql.used.get({ id: object.id, cutoff }).used) {
        kept += 1
        continue
      }
      await bytes.delete(object.id)
      metaCache.delete(object.id)
      removed.push(object.id)
      freed += object.size
    }
    const temporary = typeof bytes.cleanTemporary === 'function' ? await bytes.cleanTemporary(DAY, now) : 0
    return { removed, kept, freed, temporary, dropped, purged }
  }

  /** A whole, consistent copy of the database at `path`, taken while it stays in use. The objects
   * are the byte store's to back up; they never change, so copying the new ones is enough. */
  async function backup(path) {
    if (typeof sqlite.backup === 'function') await sqlite.backup(db, path)
    else db.prepare('VACUUM INTO ?').run(path)
  }

  /** A refusal SQLite or the disk gives becomes one a person can be told. */
  const named = (method) => async (...args) => {
    if (closed) throw new Error('The database backend is closed')
    try {
      return await method(...args)
    } catch (error) {
      if (error instanceof BackendError) throw error
      throw sqliteProblem(error) ?? error
    }
  }

  return {
    capabilities: { otherWriters: false, durableHistory: true, createProject: !readOnly, versions: true, removeProject: !readOnly, deletedFiles: true },
    file,
    readOnly,
    createProject: named(createProject),
    listProjects: named(async () => Promise.all(sql.projects.all().map(infoOf))),
    project: named(async (id) => infoOf(projectRow(id))),
    cursor: named(async (id) => cursorOf(projectRow(id))),
    list: named(async (id) => {
      projectRow(id)
      return sql.entries
        .all(id)
        .map((row) => (row.kind === 'file' ? { ...entryOf(row), version: versionOf(row) } : entryOf(row)))
        .sort(byPath)
    }),
    stat: named(async (id, path) => {
      projectRow(id)
      servedSegments(path)
      const row = sql.entry.get(id, path)
      if (!row) return null
      return { entry: entryOf(row), version: row.kind === 'file' ? versionOf(row) : null }
    }),
    read: named(read),
    write: named(write),
    mkdir: named(makeDir),
    rename: named(move),
    remove: named(remove),
    changesSince: named(changesSince),
    subscribe: named(async (id, subscriber) => {
      projectRow(id)
      if (!subscribers.has(id)) subscribers.set(id, new Set())
      subscribers.get(id).add(subscriber)
      return () => void subscribers.get(id)?.delete(subscriber)
    }),
    recent: named(recent),
    versions: named(versions),
    readVersion: named(readVersion),
    restore: named(restore),
    deletedFiles: named(deletedFiles),
    removeProject: named(removeProject),
    removedProjects: named(removedProjects),
    restoreProject: named(restoreProject),
    usage: named(async (id) => {
      const row = id === undefined ? sql.usage.get() : (projectRow(id), sql.projectUsage.get(id))
      return { bytes: row.bytes, files: row.files }
    }),
    sweep: named(sweep),
    backup: named(backup),
    close() {
      if (closed) return
      closed = true
      for (const set of subscribers.values()) for (const subscriber of set) subscriber.end()
      subscribers.clear()
      db.close()
      bytes.close?.()
    },
  }
}

const newEpoch = () => randomBytes(6).toString('hex')

/** Rolls back whatever transaction is open, if any (and the connection is). */
function rollback(db) {
  try {
    db.exec('ROLLBACK')
  } catch {
    // none was open
  }
}

/**
 * Opens (or makes) the database: WAL, so readers never wait for a write; `synchronous = FULL`, so
 * a transaction that has committed is on the disk, power cut included (NORMAL in WAL mode can lose
 * the last commits to a power cut, and a write here answers 200 only once it's kept); a busy
 * timeout for the moments another connection (a backup) holds the lock. A file of a newer schema
 * opens read-only, and says so. A file of an older schema is copied whole beside itself first
 * (`<file>.schema<n>-<UTC date>.bak`, never over an existing file), then migrated in place in one
 * transaction (MIGRATIONS); a migration that fails leaves the file as it was, and the copy.
 */
function openDatabase(sqlite, file, log, clock) {
  let db = new sqlite.DatabaseSync(file)
  const header = () => ({ applicationId: db.prepare('PRAGMA application_id').get().application_id, version: db.prepare('PRAGMA user_version').get().user_version })
  db.exec('PRAGMA busy_timeout = 2000')
  let { applicationId, version } = header()
  const foreign = () => {
    db.close()
    return new Error(`${file} isn't a Nebula database, so it is left as it is`)
  }
  if (applicationId !== APPLICATION_ID && applicationId !== 0) throw foreign()
  if (version > SCHEMA_VERSION) {
    db.close()
    db = new sqlite.DatabaseSync(file, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 2000')
    log(`nebula-files: ${file} was written by a newer Nebula (schema ${version}; this one knows ${SCHEMA_VERSION}), so it is served read-only`)
    return { db, readOnly: true }
  }
  if (version === 0) {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('BEGIN IMMEDIATE')
    try {
      // Checked again inside the lock: another process may have made it meanwhile.
      ;({ applicationId, version } = header())
      if (version === 0) {
        if (db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get().n > 0) {
          rollback(db)
          throw foreign()
        }
        db.exec(SCHEMA)
        db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}`)
      }
      db.exec('COMMIT')
    } catch (error) {
      rollback(db)
      throw error
    }
  }
  if (version > 0 && version < SCHEMA_VERSION) migrate(db, file, version, log, clock)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON')
  return { db, readOnly: false }
}

/**
 * Brings an older schema up to this one. The copy comes first, outside the transaction (SQLite can't
 * copy inside one): `VACUUM INTO`, the same whole and consistent copy `backup()` takes where Node has
 * no online backup, done here without waiting because the backend is made synchronously. Then each
 * step runs in one transaction that checks the version again under the lock, since another process
 * may have migrated the file meanwhile.
 */
function migrate(db, file, from, log, clock) {
  const date = new Date(clock()).toISOString().slice(0, 10)
  let copy = `${file}.schema${from}-${date}.bak`
  for (let n = 2; existsSync(copy); n += 1) copy = `${file}.schema${from}-${date}-${n}.bak`
  db.prepare('VACUUM INTO ?').run(copy)
  log(`nebula-files: ${file} is schema ${from}; copied whole to ${copy} before moving it to schema ${SCHEMA_VERSION}`)
  db.exec('PRAGMA foreign_keys = OFF')
  db.exec('BEGIN IMMEDIATE')
  try {
    let version = db.prepare('PRAGMA user_version').get().user_version
    for (; version < SCHEMA_VERSION; version += 1) MIGRATIONS[version](db)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    rollback(db)
    db.close()
    throw new Error(`${file} couldn't be moved to schema ${SCHEMA_VERSION}, so it is left as it was (a copy is at ${copy}): ${error.message}`, { cause: error })
  }
}
