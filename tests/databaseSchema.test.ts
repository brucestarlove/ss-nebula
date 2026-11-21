// @vitest-environment node
// Schema 1 to 2: every 2.0.3 database moves to 2.0.4's schema on its first open, losing nothing. The
// file is tests/fixtures/database-2.0.3, made once by 2.0.3's own backend (a6ff6cd) from synthetic
// notes: writes by two actors, a folder renamed, a rename then a remove, a new file at an old path,
// a folder removed, the same bytes saved twice. Each case works on a copy; the fixture is never opened.
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createDatabaseBackend, SCHEMA_VERSION } from '../cli/backends/database.mjs'
import { ADA, bytesOf, cleanScratch, copyOfFixture, put, raw, rowsOf, scalar, scratch, textOf } from './databaseSupport'

afterEach(cleanScratch)

const CLOCK = () => Date.parse('2026-12-02T09:00:00.000Z')
const BAK = 'nebula.db.schema1-2026-12-02.bak'

function open(dir: string, log: (message: string) => void = () => {}) {
  return createDatabaseBackend({ folder: dir, clock: CLOCK, log })
}

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
const OLD_CHANGE_COLUMNS = 'id, project, seq, epoch, at, type, path, from_path, to_path, actor, context, client, object'

describe('database schema 1 to 2 (a file made by 2.0.3)', () => {
  it('opens at schema 2 with every list and cursor as it was, a copy at schema 1 holding every change, and the integrity check ok', async () => {
    const dir = copyOfFixture()
    const file = join(dir, 'nebula.db')
    // What 2.0.3 held, read raw from a second copy so the file under test is touched only by the backend.
    const before = copyOfFixture()
    const oldDb = join(before, 'nebula.db')
    expect(scalar(oldDb, 'PRAGMA user_version')).toBe(1)
    const oldEntries = rowsOf(oldDb, "SELECT project, path, kind, rev, size, id FROM entries WHERE path <> '.nebula' AND path NOT LIKE '.nebula/%' ORDER BY project, path")
    const oldCursors = rowsOf(oldDb, 'SELECT id, epoch, seq FROM projects ORDER BY id')
    const oldChanges = rowsOf(oldDb, `SELECT ${OLD_CHANGE_COLUMNS} FROM changes ORDER BY id`)
    expect(oldChanges.length).toBeGreaterThan(20)

    const logged: string[] = []
    const backend = open(dir, (message) => logged.push(message))
    try {
      expect(scalar(file, 'PRAGMA user_version')).toBe(SCHEMA_VERSION)
      expect(scalar(file, 'PRAGMA integrity_check')).toBe('ok')
      for (const project of ['alpha', 'beta']) {
        const expected = oldEntries
          .filter((row) => row.project === project)
          .map((row) => ({ path: row.path, type: row.kind, ...(row.kind === 'file' ? { version: `${(row.id as number).toString(36)}:${row.rev}`, size: row.size } : {}) }))
        const listed = (await backend.list(project)).map((entry) => ({ path: entry.path, type: entry.type, ...(entry.type === 'file' ? { version: entry.version, size: entry.size } : {}) }))
        expect(listed).toEqual(expected)
        const cursor = oldCursors.find((row) => row.id === project)
        expect(await backend.cursor(project)).toBe(`${cursor?.epoch}:${cursor?.seq}`)
      }
      // The copy is beside the file, at schema 1, with every change as it was; the log says where it is.
      const copy = join(dir, BAK)
      expect(existsSync(copy)).toBe(true)
      expect(scalar(copy, 'PRAGMA user_version')).toBe(1)
      expect(rowsOf(copy, `SELECT ${OLD_CHANGE_COLUMNS} FROM changes ORDER BY id`)).toEqual(oldChanges)
      expect(logged.some((message) => message.includes(copy))).toBe(true)
      // And the changes themselves are unchanged in the migrated file.
      expect(rowsOf(file, `SELECT ${OLD_CHANGE_COLUMNS} FROM changes ORDER BY id`)).toEqual(oldChanges)
    } finally {
      backend.close()
    }
  })

  it('leaves a file whose shape is a new file’s: the same columns and the same indexes', () => {
    const dir = copyOfFixture()
    open(dir).close()
    const fresh = join(scratch('fresh'), 'db')
    createDatabaseBackend({ folder: fresh }).close()
    const shape = (file: string) => {
      const tables = rowsOf(file, "SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'sqlite_sequence' ORDER BY name").map((row) => row.name as string)
      return {
        tables,
        columns: Object.fromEntries(tables.map((table) => [table, rowsOf(file, `SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${table}') ORDER BY cid`)])),
        indexes: rowsOf(file, "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name").map((row) => ({ ...row, sql: String(row.sql).replace(/\s+/g, ' ') })),
      }
    }
    const migrated = shape(join(dir, 'nebula.db'))
    expect(migrated.tables).toEqual(['changes', 'entries', 'projects', 'released'])
    expect(migrated).toEqual(shape(join(fresh, 'nebula.db')))
  })

  it('names every write: a renamed file’s under its entry, a deleted file’s under a new id, and a replaced file at its path under another', async () => {
    const dir = copyOfFixture()
    const file = join(dir, 'nebula.db')
    const usedIds = Number(scalar(copyOfFixture() + '/nebula.db', "SELECT seq FROM sqlite_sequence WHERE name = 'entries'"))
    const backend = open(dir)
    try {
      expect(scalar(file, "SELECT COUNT(*) FROM changes WHERE type = 'write' AND (entry IS NULL OR rev IS NULL)")).toBe(0)
      const entryOf = (project: string, path: string) => Number(scalar(file, 'SELECT id FROM entries WHERE project = ? AND path = ?', project, path))
      const writes = (path: string) => rowsOf(file, "SELECT entry, rev, path FROM changes WHERE project = 'alpha' AND type = 'write' AND path = ? ORDER BY seq", path)
      // notes/a.md was written three times, its folder renamed, and written once more at docs/a.md: one file, four revisions.
      const lines = [...writes('notes/a.md'), ...writes('docs/a.md')]
      expect(lines.map((row) => row.rev)).toEqual([1, 2, 3, 4])
      expect(new Set(lines.map((row) => row.entry))).toEqual(new Set([entryOf('alpha', 'docs/a.md')]))
      // c.md was renamed to d.md, then removed: its two writes share one id that no entry ever held.
      const deleted = writes('c.md')
      expect(deleted.map((row) => row.rev)).toEqual([1, 2])
      expect(deleted[0].entry).toBe(deleted[1].entry)
      expect(deleted[0].entry as number).toBeGreaterThan(usedIds)
      // e.md, removed and then written again: the new file is not the old one.
      const [oldOne, oldTwo, fresh] = writes('e.md')
      expect(oldOne.entry).toBe(oldTwo.entry)
      expect(fresh.entry).not.toBe(oldOne.entry)
      expect(fresh.entry).toBe(entryOf('alpha', 'e.md'))
      expect([oldOne.rev, oldTwo.rev, fresh.rev]).toEqual([1, 2, 1])
      // What a remove let go names the file and the path it had then (d.md, though its writes say c.md).
      expect(scalar(file, "SELECT COUNT(*) FROM released WHERE path = 'd.md' AND entry = ?", deleted[0].entry)).toBe(1)
      // A folder removed: both files under it have a line of their own.
      expect(scalar(file, "SELECT COUNT(DISTINCT entry) FROM changes WHERE type = 'write' AND path LIKE 'old/%'")).toBe(2)

      // The history reads back as it was written: bytes, actors, and the paths as they were then.
      const listed = (await backend.versions('alpha', 'docs/a.md')).versions
      expect(listed.map((version) => [version.path, version.actor?.id, version.current])).toEqual([
        ['docs/a.md', 'lear', true],
        ['notes/a.md', 'ada', false],
        ['notes/a.md', 'lear', false],
        ['notes/a.md', 'ada', false],
      ])
      expect(await textOf(backend, 'alpha', 'docs/a.md', listed[3].version)).toBe('a one')
      expect(await textOf(backend, 'alpha', 'docs/a.md', listed[2].version)).toBe('a two by lear')
      // A deleted file's history is reached by its last path, and its bytes read.
      const gone = (await backend.versions('alpha', 'd.md')).versions
      expect(gone).toHaveLength(2)
      expect(gone.every((version) => version.current === false)).toBe(true)
      expect(await textOf(backend, 'alpha', 'd.md', gone[0].version)).toBe('c two')
      expect(Array.from(await bytesOf(backend, 'alpha', 'dot.bin'))).toEqual([0, 1, 2, 250, 251, 252])
    } finally {
      backend.close()
    }
  })

  it('on a second open neither migrates nor copies', () => {
    const dir = copyOfFixture()
    const logged: string[] = []
    open(dir, (message) => logged.push(message)).close()
    const copies = readdirSync(dir).filter((name) => name.endsWith('.bak'))
    expect(copies).toEqual([BAK])
    const copySum = sha(join(dir, BAK))
    expect(logged).toHaveLength(1)
    const again: string[] = []
    open(dir, (message) => again.push(message)).close()
    expect(again).toEqual([])
    expect(readdirSync(dir).filter((name) => name.endsWith('.bak'))).toEqual([BAK])
    expect(sha(join(dir, BAK))).toBe(copySum)
  })

  it('never writes over a copy already there: a second one that day is -2', () => {
    const dir = copyOfFixture()
    writeFileSync(join(dir, BAK), 'a copy that is not ours to overwrite')
    open(dir).close()
    expect(readFileSync(join(dir, BAK), 'utf8')).toBe('a copy that is not ours to overwrite')
    const second = join(dir, 'nebula.db.schema1-2026-12-02-2.bak')
    expect(existsSync(second)).toBe(true)
    expect(scalar(second, 'PRAGMA user_version')).toBe(1)
    expect(scalar(second, 'SELECT COUNT(*) FROM changes')).toBe(24)
  })

  it('keeps working after the move: a write is the next revision of a migrated file, and its old versions are still there', async () => {
    const dir = copyOfFixture()
    const backend = open(dir)
    try {
      const before = await backend.stat('alpha', 'docs/a.md')
      expect(before?.version).toBe('6:4')
      const written = await put(backend, 'alpha', 'docs/a.md', 'a five, after the move', { actor: ADA, ifMatch: '6:4' })
      expect(written.version).toBe('6:5')
      const listed = (await backend.versions('alpha', 'docs/a.md')).versions
      expect(listed.map((version) => version.version)).toEqual(['6:5', '6:4', '6:3', '6:2', '6:1'])
    } finally {
      backend.close()
    }
  })
})

describe('a migration that fails', () => {
  /** The 2.0.3 file with one of 2.0.4's columns added by hand, so the migration's own ALTER fails. */
  function broken() {
    const dir = copyOfFixture()
    const file = join(dir, 'nebula.db')
    const db = raw(file)
    db.exec('ALTER TABLE changes ADD COLUMN entry INTEGER')
    db.close()
    return { dir, file }
  }
  const everything = (file: string) =>
    JSON.stringify(['projects', 'entries', 'changes', 'released'].map((table) => [rowsOf(file, `SELECT * FROM ${table}`), rowsOf(file, `SELECT name, type FROM pragma_table_info('${table}')`)]))

  it('throws, says where the copy is, and leaves the file at schema 1 exactly as it was', () => {
    const { dir, file } = broken()
    const state = everything(file)
    const columns = rowsOf(file, "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
    let failure: Error | undefined
    try {
      open(dir)
    } catch (error) {
      failure = error as Error
    }
    expect(failure).toBeInstanceOf(Error)
    // The copy was taken before the attempt, and the message names it.
    const copy = join(dir, BAK)
    expect(existsSync(copy)).toBe(true)
    expect(failure?.message).toContain(copy)
    expect(scalar(copy, 'PRAGMA user_version')).toBe(1)
    // The file: schema 1, no table touched (no column of an earlier ALTER survived), no index added.
    expect(scalar(file, 'PRAGMA user_version')).toBe(1)
    expect(scalar(file, 'PRAGMA integrity_check')).toBe('ok')
    expect(everything(file)).toBe(state)
    expect(rowsOf(file, "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")).toEqual(columns)
    expect(rowsOf(file, "SELECT name FROM pragma_table_info('projects') WHERE name IN ('removed', 'removed_by', 'purged')")).toEqual([])
  })

  it('can be tried again once the cause is gone, and then moves', async () => {
    const { dir, file } = broken()
    expect(() => open(dir)).toThrow()
    // Undo the hand-made column (SQLite can drop a column nothing refers to), and the same file migrates.
    const db = raw(file)
    db.exec('ALTER TABLE changes DROP COLUMN entry')
    db.close()
    const backend = open(dir)
    try {
      expect(scalar(file, 'PRAGMA user_version')).toBe(SCHEMA_VERSION)
      expect((await backend.versions('alpha', 'docs/a.md')).versions).toHaveLength(4)
      // The failed attempt's copy and this one's are different files.
      expect(readdirSync(dir).filter((name) => name.endsWith('.bak')).sort()).toEqual(['nebula.db.schema1-2026-12-02-2.bak', BAK])
    } finally {
      backend.close()
    }
  })
})
