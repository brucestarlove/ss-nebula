// @vitest-environment node
// 2.0.4's history on the database backend: identical saves, versions, restore, thinning, what the
// sweep frees, projects removed on purpose, a newer schema. Each case works on a database of its own
// in a scratch folder, and a clock it moves: days pass in the test, not on the machine.
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createDatabaseBackend } from '../cli/backends/database.mjs'
import { createFolderByteStore } from '../cli/bytes/folder.mjs'
import { ADA, type Backend, DAY, HOUR, LEAR, MINUTE, bytesOf, cleanScratch, copyOfFixture, objectIds, put, raw, rowsOf, scalar, scratch, textOf } from './databaseSupport'

afterEach(cleanScratch)

/** Midnight UTC two days after the machine's today: after every object these cases put in the byte
 * store (the sweep's grace counts from the file's real time), and on a thinning mark. */
const T0 = Math.floor(Date.now() / DAY) * DAY + 2 * DAY

function make(options: Record<string, unknown> = {}) {
  const dir = scratch('history')
  const file = join(dir, 'nebula.db')
  const bytes = createFolderByteStore({ root: join(dir, 'bytes') })
  const state = { now: T0 }
  const backend: Backend = createDatabaseBackend({ file, bytes, clock: () => state.now, ...options })
  return { backend, bytes, state, dir, file }
}

type Made = ReturnType<typeof make>

async function started(options: Record<string, unknown> = {}) {
  const made = make(options)
  const { id } = await made.backend.createProject({ name: 'History' }, { actor: ADA })
  return { ...made, id }
}

/** A file's kept versions, every page. */
async function allVersions(backend: Made['backend'], id: string, path: string) {
  const all = []
  let before: string | undefined
  do {
    const page = await backend.versions(id, path, { limit: 50, before })
    all.push(...page.versions)
    before = page.next ?? undefined
  } while (before)
  return all
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return (error as { code?: string }).code
  }
  return 'resolved'
}

describe('an identical save stores nothing', () => {
  it('answers the same version and cursor, appends no record, tells nobody, and keeps who last changed the file', async () => {
    const { backend, id } = await started()
    try {
      const first = await put(backend, id, 'note.md', 'the same words', { actor: ADA })
      const heard: unknown[] = []
      await backend.subscribe(id, { change: (record: unknown) => heard.push(record), end() {} })
      const cursor = await backend.cursor(id)
      const again = await put(backend, id, 'note.md', 'the same words', { actor: LEAR })
      expect(again.version).toBe(first.version)
      expect(again.cursor).toBe(cursor)
      expect(await backend.cursor(id)).toBe(cursor)
      expect((await backend.changesSince(id, cursor)).changes).toEqual([])
      expect(heard).toEqual([])
      expect((await backend.list(id)).find((entry) => entry.path === 'note.md')?.modifiedBy?.id).toBe('ada')
      expect(await allVersions(backend, id, 'note.md')).toHaveLength(1)
      // Different bytes are still a revision.
      const changed = await put(backend, id, 'note.md', 'other words', { actor: LEAR })
      expect(changed.version).not.toBe(first.version)
    } finally {
      backend.close()
    }
  })

  it('still refuses a stale ifMatch, with the same bytes', async () => {
    const { backend, id } = await started()
    try {
      const first = await put(backend, id, 'note.md', 'one')
      await put(backend, id, 'note.md', 'two')
      expect(await code(put(backend, id, 'note.md', 'two', { ifMatch: first.version }))).toBe('precondition')
      expect(await code(put(backend, id, 'note.md', 'one', { ifMatch: first.version }))).toBe('precondition')
    } finally {
      backend.close()
    }
  })

  it('counts nothing against usage', async () => {
    const { backend, id } = await started()
    try {
      await put(backend, id, 'note.md', 'x'.repeat(100))
      const before = await backend.usage(id)
      for (let count = 0; count < 5; count += 1) await put(backend, id, 'note.md', 'x'.repeat(100))
      expect(await backend.usage(id)).toEqual(before)
    } finally {
      backend.close()
    }
  })
})

describe('versions', () => {
  it('lists newest first with the current one first, each with its time, size, actor, context and path as written', async () => {
    const { backend, id, state } = await started()
    try {
      await put(backend, id, 'a/note.md', 'one', { actor: ADA })
      state.now += MINUTE
      await put(backend, id, 'a/note.md', 'two!', { actor: LEAR, context: 'orbit:card/b/1' })
      state.now += MINUTE
      await backend.rename(id, 'a', 'b', { actor: ADA })
      state.now += MINUTE
      await put(backend, id, 'b/note.md', 'three!!', { actor: ADA })
      const { versions, next } = await backend.versions(id, 'b/note.md')
      expect(next).toBeNull()
      expect(versions.map((version) => [version.current, version.size, version.actor?.id, version.path, version.context])).toEqual([
        [true, 7, 'ada', 'b/note.md', undefined],
        [false, 4, 'lear', 'a/note.md', 'orbit:card/b/1'],
        [false, 3, 'ada', 'a/note.md', undefined],
      ])
      expect(versions.map((version) => version.at)).toEqual([T0 + 3 * MINUTE, T0 + MINUTE, T0].map((time) => new Date(time).toISOString()))
      // The current one's version is the file's own.
      expect(versions[0].version).toBe((await backend.stat(id, 'b/note.md'))?.version)
      // The path it had then reaches the same history.
      expect((await backend.versions(id, 'a/note.md')).versions.map((version) => version.version)).toEqual(versions.map((version) => version.version))
    } finally {
      backend.close()
    }
  })

  it('pages by limit and before, with no version twice or missed', async () => {
    const { backend, id } = await started()
    try {
      for (let count = 1; count <= 7; count += 1) await put(backend, id, 'n.md', `revision ${count}`)
      const seen: string[] = []
      let before: string | undefined
      let pages = 0
      do {
        const page = await backend.versions(id, 'n.md', { limit: 3, before })
        expect(page.versions.length).toBeLessThanOrEqual(3)
        seen.push(...page.versions.map((version) => version.version))
        before = page.next ?? undefined
        pages += 1
      } while (before && pages < 10)
      // It ends (a page that fills the limit may be followed by an empty one, as `recent`'s is).
      expect(before).toBeUndefined()
      expect(pages).toBeGreaterThanOrEqual(3)
      expect(seen).toHaveLength(7)
      expect(new Set(seen).size).toBe(7)
      expect(seen).toEqual([...seen].sort((a, b) => Number(b.split(':')[1]) - Number(a.split(':')[1])))
      // One page that holds them all, or the limit past them, has no next.
      expect((await backend.versions(id, 'n.md', { limit: 8 })).next).toBeNull()
    } finally {
      backend.close()
    }
  })

  it('answers a deleted file’s history by its last path, also after a rename and then a remove', async () => {
    const { backend, id } = await started()
    try {
      await put(backend, id, 'gone.md', 'one')
      await put(backend, id, 'gone.md', 'two')
      await backend.remove(id, 'gone.md')
      const deleted = (await backend.versions(id, 'gone.md')).versions
      expect(deleted.map((version) => version.current)).toEqual([false, false])
      expect(await textOf(backend, id, 'gone.md', deleted[0].version)).toBe('two')
      await put(backend, id, 'moved.md', 'a')
      await put(backend, id, 'moved.md', 'b')
      await backend.rename(id, 'moved.md', 'elsewhere.md')
      await backend.remove(id, 'elsewhere.md')
      expect(await allVersions(backend, id, 'elsewhere.md')).toHaveLength(2)
      expect(await allVersions(backend, id, 'moved.md')).toHaveLength(2)
    } finally {
      backend.close()
    }
  })

  it('refuses a path no file was at (not-found) and a folder (type)', async () => {
    const { backend, id } = await started()
    try {
      await put(backend, id, 'dir/note.md', 'x')
      expect(await code(backend.versions(id, 'never.md'))).toBe('not-found')
      expect(await code(backend.versions(id, 'dir'))).toBe('type')
    } finally {
      backend.close()
    }
  })
})

describe('readVersion', () => {
  it('gives the version’s bytes whole, and only for this file’s versions', async () => {
    const { backend, id } = await started()
    try {
      const bytes = new Uint8Array(70_000).map((_, index) => (index * 7 + (index >> 8)) % 256)
      await put(backend, id, 'a.bin', bytes)
      await put(backend, id, 'a.bin', 'later')
      await put(backend, id, 'b.md', 'b one')
      await put(backend, id, 'b.md', 'b two')
      const old = (await backend.versions(id, 'a.bin')).versions[1]
      expect(Array.from(await bytesOf(backend, id, 'a.bin', old.version))).toEqual(Array.from(bytes))
      const other = (await backend.versions(id, 'b.md')).versions[1]
      expect(await code(backend.readVersion(id, 'a.bin', other.version))).toBe('not-found')
      expect(await code(backend.readVersion(id, 'a.bin', 'zz:1'))).toBe('not-found')
      expect(await code(backend.readVersion(id, 'a.bin', `${old.version.split(':')[0]}:99`))).toBe('not-found')
    } finally {
      backend.close()
    }
  })

  it('is not-found for a version thinning dropped, and for one whose object has gone from the byte store', async () => {
    const { backend, bytes, id, state, file } = await started()
    try {
      // Three saves in one window by one actor: thinning keeps the newest of the window only.
      await put(backend, id, 'n.md', 'one', { actor: ADA })
      await put(backend, id, 'n.md', 'two', { actor: ADA })
      await put(backend, id, 'n.md', 'three', { actor: ADA })
      const before = await allVersions(backend, id, 'n.md')
      expect(before).toHaveLength(3)
      state.now = T0 + 3 * DAY
      // Its objects are left in the byte store (a grace nobody outlasts): only the dropped mark says no.
      const { dropped } = await backend.sweep({ now: T0 + 3 * DAY, graceMinutes: 1e9 })
      expect(dropped).toBeGreaterThan(0)
      const after = await allVersions(backend, id, 'n.md')
      const gone = before.filter((version) => !after.some((each) => each.version === version.version))
      expect(gone.length).toBeGreaterThan(0)
      for (const version of gone) expect(await code(backend.readVersion(id, 'n.md', version.version))).toBe('not-found')
      for (const version of after) expect(await textOf(backend, id, 'n.md', version.version)).toBeTypeOf('string')
      // A kept version whose object was taken from the byte store some other way.
      await put(backend, id, 'm.md', 'm one', { actor: ADA })
      await put(backend, id, 'm.md', 'm two', { actor: LEAR })
      const [, older] = (await backend.versions(id, 'm.md')).versions
      const object = String(scalar(file, "SELECT object FROM changes WHERE type = 'write' AND path = 'm.md' ORDER BY seq LIMIT 1"))
      await bytes.delete(object)
      expect(await code(backend.readVersion(id, 'm.md', older.version))).toBe('not-found')
    } finally {
      backend.close()
    }
  })
})

describe('restore', () => {
  it('brings a 70 KB binary back as a new revision sharing the old object, logged as the restorer’s write with restoredFrom', async () => {
    const { backend, bytes, id, state } = await started()
    try {
      const original = new Uint8Array(70_000).map((_, index) => (index * 13 + (index >> 7)) % 256)
      await put(backend, id, 'pic.bin', original, { actor: ADA })
      state.now += MINUTE
      await put(backend, id, 'pic.bin', 'not a picture any more', { actor: ADA })
      const [current, first] = (await backend.versions(id, 'pic.bin')).versions
      const objects = await objectIds(bytes)
      const heard: Array<{ type: string; path: string; restoredFrom?: string; actor?: { id: string } }> = []
      await backend.subscribe(id, { change: (record: (typeof heard)[number]) => heard.push(record), end() {} })
      const start = await backend.cursor(id)
      state.now += MINUTE
      const restored = await backend.restore(id, 'pic.bin', first.version, { actor: LEAR, ifMatch: current.version })
      // Bytes equal, the next revision of the same file, and no new object.
      expect(Array.from(await bytesOf(backend, id, 'pic.bin'))).toEqual(Array.from(original))
      expect(restored.version).toBe(`${current.version.split(':')[0]}:3`)
      expect(await objectIds(bytes)).toEqual(objects)
      // The record: a write by the restorer, heard live and in /changes, naming what it brought back.
      const [record] = (await backend.changesSince(id, start)).changes
      expect(record).toMatchObject({ type: 'write', path: 'pic.bin', restoredFrom: first.version, actor: { id: 'lear' } })
      expect(heard).toHaveLength(1)
      expect(heard[0]).toMatchObject({ type: 'write', path: 'pic.bin', restoredFrom: first.version, actor: { id: 'lear' } })
      expect((await backend.recent({ project: id, limit: 1 })).changes[0]).toMatchObject({ restoredFrom: first.version })
      // The version it replaced stays readable, and the history lists the restore as the current one.
      const history = (await backend.versions(id, 'pic.bin')).versions
      expect(history.map((version) => [version.current, version.restoredFrom])).toEqual([
        [true, first.version],
        [false, undefined],
        [false, undefined],
      ])
      expect(await textOf(backend, id, 'pic.bin', current.version)).toBe('not a picture any more')
      expect((await backend.stat(id, 'pic.bin'))?.entry.modifiedBy?.id).toBe('lear')
    } finally {
      backend.close()
    }
  })

  it('refuses a stale ifMatch and ifAbsent over an existing file with 412, and bytes equal to the file’s now change nothing', async () => {
    const { backend, id } = await started()
    try {
      const one = await put(backend, id, 'n.md', 'one')
      const two = await put(backend, id, 'n.md', 'two')
      const three = await put(backend, id, 'n.md', 'one')
      const history = (await backend.versions(id, 'n.md')).versions
      const second = history[1].version
      const cursor = await backend.cursor(id)
      expect(await code(backend.restore(id, 'n.md', second, { ifMatch: one.version }))).toBe('precondition')
      expect(await code(backend.restore(id, 'n.md', second, { ifMatch: two.version }))).toBe('precondition')
      expect(await code(backend.restore(id, 'n.md', second, { ifAbsent: true }))).toBe('precondition')
      expect(await textOf(backend, id, 'n.md')).toBe('one')
      expect(await backend.cursor(id)).toBe(cursor)
      // Version 1 holds the bytes the file holds now: nothing to record.
      const same = await backend.restore(id, 'n.md', one.version, { ifMatch: three.version })
      expect(same.version).toBe(three.version)
      expect(await backend.cursor(id)).toBe(cursor)
      expect(await code(backend.restore(id, 'n.md', second, { ifMatch: three.version }))).toBe('resolved')
      expect(await textOf(backend, id, 'n.md')).toBe('two')
    } finally {
      backend.close()
    }
  })

  it('brings a deleted file back under its own entry, at the next revision, so its history goes on', async () => {
    const { backend, id } = await started()
    try {
      await put(backend, id, 'doomed.md', 'first')
      await put(backend, id, 'doomed.md', 'second')
      const [, newest] = [null, (await backend.versions(id, 'doomed.md')).versions[0]]
      const entry = newest.version.split(':')[0]
      await backend.remove(id, 'doomed.md')
      expect(await backend.stat(id, 'doomed.md')).toBeNull()
      expect(await code(backend.restore(id, 'doomed.md', newest.version, { ifMatch: newest.version }))).toBe('precondition')
      const back = await backend.restore(id, 'doomed.md', newest.version, { ifAbsent: true })
      expect(back.version).toBe(`${entry}:3`)
      expect(await textOf(backend, id, 'doomed.md')).toBe('second')
      const history = await allVersions(backend, id, 'doomed.md')
      expect(history.map((version) => version.version)).toEqual([`${entry}:3`, `${entry}:2`, `${entry}:1`])
    } finally {
      backend.close()
    }
  })

  it('brings back, at the path of a file that moved on, a new file, and leaves the moved one alone', async () => {
    const { backend, id } = await started()
    try {
      await put(backend, id, 'a.md', 'one')
      await put(backend, id, 'a.md', 'two')
      const oldest = (await backend.versions(id, 'a.md')).versions[1]
      await backend.rename(id, 'a.md', 'b.md')
      const made = await backend.restore(id, 'a.md', oldest.version, { ifAbsent: true })
      expect(await textOf(backend, id, 'a.md')).toBe('one')
      expect(made.version.endsWith(':1')).toBe(true)
      expect(made.version.split(':')[0]).not.toBe(oldest.version.split(':')[0])
      expect(await textOf(backend, id, 'b.md')).toBe('two')
      expect((await backend.stat(id, 'b.md'))?.version).toBe((await backend.versions(id, 'b.md')).versions[0].version)
      expect(await allVersions(backend, id, 'b.md')).toHaveLength(2)
    } finally {
      backend.close()
    }
  })

  it('is not-found for a version that isn’t the file’s, a version nobody wrote, and a path no file was at', async () => {
    const { backend, id } = await started()
    try {
      await put(backend, id, 'a.md', 'one')
      await put(backend, id, 'a.md', 'two')
      await put(backend, id, 'b.md', 'b')
      const other = (await backend.versions(id, 'b.md')).versions[0].version
      expect(await code(backend.restore(id, 'a.md', other, { ifMatch: (await backend.stat(id, 'a.md'))?.version ?? '' }))).toBe('not-found')
      // At a path nothing holds now (a taken path answers `precondition` first: deletedFiles.test.ts).
      expect(await code(backend.restore(id, 'gone.md', 'nonsense', { ifAbsent: true }))).toBe('not-found')
      expect(await code(backend.restore(id, 'nothing.md', other))).toBe('not-found')
    } finally {
      backend.close()
    }
  })
})

describe('thinning', () => {
  /** Saves a file `count` times over `days` days by one actor, sweeping as `sweepEvery` says (never: once, at the end). */
  async function saves(count: number, days: number, sweepEvery?: number) {
    const made = await started()
    const { backend, state } = made
    const start = T0 - days * DAY
    let swept = start
    for (let index = 0; index < count; index += 1) {
      state.now = start + Math.floor((index * days * DAY) / count)
      await put(backend, made.id, 'busy.md', `save ${index}`, { actor: ADA })
      if (sweepEvery && state.now - swept >= sweepEvery) {
        await backend.sweep({ now: state.now })
        swept = state.now
      }
    }
    state.now = T0
    await backend.sweep({ now: T0 })
    return made
  }

  it('leaves at most 45 versions of 1,000 saves over 14 days, all readable, the newest the current file, the same set whether swept every few hours or once', { timeout: 120_000 }, async () => {
    const once = await saves(1000, 14)
    const often = await saves(1000, 14, 4 * HOUR)
    try {
      const kept = await allVersions(once.backend, once.id, 'busy.md')
      expect(kept.length).toBeLessThanOrEqual(45)
      expect(kept.length).toBeGreaterThanOrEqual(36)
      expect(kept[0]).toMatchObject({ current: true })
      expect(await textOf(once.backend, once.id, 'busy.md')).toBe('save 999')
      for (const version of kept) expect(await bytesOf(once.backend, once.id, 'busy.md', version.version)).toBeInstanceOf(Uint8Array)
      expect(kept.filter((version) => version.current)).toHaveLength(1)
      const oftenKept = await allVersions(often.backend, often.id, 'busy.md')
      expect(oftenKept.map((version) => version.version)).toEqual(kept.map((version) => version.version))
      // The log keeps every save, dropped or not.
      expect((await once.backend.changesSince(once.id, `${(await once.backend.cursor(once.id)).split(':')[0]}:0`)).changes).toHaveLength(1000)
    } finally {
      once.backend.close()
      often.backend.close()
    }
  })

  it('keeps the version before another actor’s save until keepDays after that save', async () => {
    const { backend, id, state } = await started()
    try {
      const at = T0 - 20 * DAY + 3 * HOUR + 10 * MINUTE
      const write = async (minutes: number, text: string, actor: typeof ADA | typeof LEAR) => {
        state.now = at + minutes * MINUTE
        return put(backend, id, 'n.md', text, { actor })
      }
      const v1 = await write(1, 'one', ADA)
      const v2 = await write(2, 'two', ADA)
      const v3 = await write(3, 'three', LEAR)
      const v4 = await write(4, 'four', ADA)
      const list = async () => (await allVersions(backend, id, 'n.md')).map((version) => version.version)
      // A day on: v2 (ended by Lear's save) and v3 (ended by Ada's, over Lear's) are kept; v1 (ended by its own actor) is not.
      await backend.sweep({ now: at + DAY })
      expect(await list()).toEqual([v4.version, v3.version, v2.version])
      expect(v1.version).not.toBe(v2.version)
      // Just before keepDays after Lear's save v2 stays, and v3 stays until keepDays after Ada's next save.
      await backend.sweep({ now: at + 3 * MINUTE + 14 * DAY - MINUTE })
      expect(await list()).toEqual([v4.version, v3.version, v2.version])
      // keepDays after the save that ended v2: it goes; v3 a minute later.
      await backend.sweep({ now: at + 3 * MINUTE + 14 * DAY + MINUTE })
      expect(await list()).toEqual([v4.version, v3.version])
      await backend.sweep({ now: at + 4 * MINUTE + 14 * DAY + MINUTE })
      expect(await list()).toEqual([v4.version])
    } finally {
      backend.close()
    }
  })

  it('keeps the version a remove let go, and the one a restore replaced, until keepDays after', async () => {
    const { backend, id, state } = await started()
    try {
      const at = T0 - 20 * DAY + 3 * HOUR + 10 * MINUTE
      state.now = at
      await put(backend, id, 'removed.md', 'one', { actor: ADA })
      state.now += MINUTE
      const last = await put(backend, id, 'removed.md', 'two', { actor: ADA })
      state.now += MINUTE
      await backend.remove(id, 'removed.md', { actor: ADA })
      const removedAt = state.now
      state.now += MINUTE
      await put(backend, id, 'replaced.md', 'a', { actor: ADA })
      state.now += MINUTE
      const b = await put(backend, id, 'replaced.md', 'b', { actor: ADA })
      state.now += MINUTE
      const [, first] = (await backend.versions(id, 'replaced.md')).versions
      await backend.restore(id, 'replaced.md', first.version, { actor: ADA, ifMatch: b.version })
      const restoredAt = state.now
      const versionsOf = async (path: string) => (await allVersions(backend, id, path)).map((version) => version.version)
      await backend.sweep({ now: at + DAY })
      expect(await versionsOf('removed.md')).toEqual([last.version])
      expect((await versionsOf('replaced.md')).includes(b.version)).toBe(true)
      await backend.sweep({ now: removedAt + 14 * DAY - MINUTE })
      expect(await versionsOf('removed.md')).toEqual([last.version])
      await backend.sweep({ now: removedAt + 14 * DAY + MINUTE })
      expect(await versionsOf('removed.md')).toEqual([])
      expect((await versionsOf('replaced.md')).includes(b.version)).toBe(true)
      await backend.sweep({ now: restoredAt + 14 * DAY + MINUTE })
      expect((await versionsOf('replaced.md')).includes(b.version)).toBe(false)
    } finally {
      backend.close()
    }
  })

  it('drops a version past keepDays from its end, and keepDays is the backend’s own', async () => {
    const { backend, id, state } = await started({ keepDays: 3 })
    try {
      const at = T0 - 10 * DAY + 3 * HOUR + 10 * MINUTE
      state.now = at
      await put(backend, id, 'n.md', 'one', { actor: ADA })
      state.now += MINUTE
      await put(backend, id, 'n.md', 'two', { actor: LEAR })
      state.now += MINUTE
      await put(backend, id, 'n.md', 'three', { actor: ADA })
      await backend.sweep({ now: at + 2 * DAY })
      expect(await allVersions(backend, id, 'n.md')).toHaveLength(3)
      await backend.sweep({ now: at + 4 * DAY })
      expect(await allVersions(backend, id, 'n.md')).toHaveLength(1)
    } finally {
      backend.close()
    }
  })
})

describe('the sweep frees only what thinning dropped', () => {
  /** Every object the log or the entries name, and which of them a kept version, an entry or a release holds. */
  function holding(file: string) {
    const named = (sql: string) => new Set(rowsOf(file, sql).map((row) => String(row.object)))
    return {
      everything: named('SELECT object FROM changes WHERE object IS NOT NULL UNION SELECT object FROM released UNION SELECT object FROM entries WHERE object IS NOT NULL'),
      entries: named('SELECT object FROM entries WHERE object IS NOT NULL'),
      kept: named("SELECT object FROM changes WHERE type = 'write' AND object IS NOT NULL AND dropped IS NULL"),
    }
  }

  it('removes the objects of dropped versions and no object an entry or a kept version names, at any age', async () => {
    const { backend, bytes, id, state, file } = await started()
    try {
      const at = T0 - 20 * DAY + 3 * HOUR + 10 * MINUTE
      for (let index = 0; index < 30; index += 1) {
        state.now = at + index * 7 * MINUTE
        await put(backend, id, 'busy.md', `save ${index}`, { actor: index % 11 === 10 ? LEAR : ADA })
      }
      await put(backend, id, 'other.md', 'other', { actor: ADA })
      const beforeIds = await objectIds(bytes)
      const result = await backend.sweep({ now: T0 })
      expect(result.dropped).toBeGreaterThan(0)
      const afterIds = await objectIds(bytes)
      const held = holding(file)
      // What went is exactly what nothing now holds; what stayed is what an entry or a kept version names.
      expect(result.removed.sort()).toEqual(beforeIds.filter((object) => !afterIds.includes(object)))
      for (const object of afterIds) expect(held.kept.has(object) || held.entries.has(object) || rowsOf(file, 'SELECT 1 FROM released WHERE object = ?', object).length > 0).toBe(true)
      // Every object a dropped version held and nothing else holds is gone.
      const droppedObjects = rowsOf(file, "SELECT DISTINCT object FROM changes WHERE type = 'write' AND dropped IS NOT NULL").map((row) => String(row.object))
      const orphaned = droppedObjects.filter((object) => !held.kept.has(object) && !held.entries.has(object))
      expect(orphaned.length).toBeGreaterThan(0)
      for (const object of orphaned) expect(afterIds.includes(object), object).toBe(false)
      for (const object of held.entries) expect(afterIds.includes(object)).toBe(true)
      for (const object of held.kept) expect(afterIds.includes(object)).toBe(true)
      expect(result.freed).toBeGreaterThan(0)
      // The versions listed read back whole.
      for (const version of await allVersions(backend, id, 'busy.md')) expect(await textOf(backend, id, 'busy.md', version.version)).toMatch(/^save \d+$/)
      // A second sweep finds nothing more.
      expect((await backend.sweep({ now: T0 })).removed).toEqual([])
    } finally {
      backend.close()
    }
  })

  it('keeps project.json’s first object by the 14-day rule: a change within keepDays holds it, and past keepDays it goes', async () => {
    const { backend, bytes, id, state, file } = await started()
    try {
      const first = String(scalar(file, "SELECT object FROM entries WHERE path = '.nebula/project.json'"))
      state.now = T0 + DAY
      const meta = JSON.parse(await textOf(backend, id, '.nebula/project.json'))
      await put(backend, id, '.nebula/project.json', JSON.stringify({ ...meta, name: 'Renamed' }), { actor: ADA })
      expect((await objectIds(bytes)).includes(first)).toBe(true)
      await backend.sweep({ now: T0 + 2 * DAY })
      expect((await objectIds(bytes)).includes(first)).toBe(true)
      await backend.sweep({ now: T0 + DAY + 14 * DAY - MINUTE })
      expect((await objectIds(bytes)).includes(first)).toBe(true)
      await backend.sweep({ now: T0 + DAY + 14 * DAY + MINUTE })
      expect((await objectIds(bytes)).includes(first)).toBe(false)
      expect((await backend.project(id)).name).toBe('Renamed')
    } finally {
      backend.close()
    }
  })

  it('keeps an unnamed 2.0.3 write’s object 14 days from its write, as 2.0.3 did, and frees it after', async () => {
    // A 2.0.3 file whose entry no longer agrees with its log (the revision is wrong), so the migration can't name its writes.
    const dir = copyOfFixture()
    const db = raw(join(dir, 'nebula.db'))
    db.exec("UPDATE entries SET rev = 99 WHERE path = 'docs/b.md' OR path = 'notes/b.md'")
    db.exec("UPDATE entries SET rev = 99 WHERE path = 'same.md'")
    db.close()
    const file = join(dir, 'nebula.db')
    const backend = createDatabaseBackend({ folder: dir })
    try {
      const unnamed = rowsOf(file, "SELECT object, at FROM changes WHERE type = 'write' AND path = 'same.md' AND entry IS NULL ORDER BY seq")
      expect(unnamed).toHaveLength(2)
      const [older] = unnamed as Array<{ object: string; at: string }>
      const wroteAt = Date.parse(older.at)
      // `same.md` is the file the migration couldn't name; its older object isn't the entry's.
      const entryObject = String(scalar(file, "SELECT object FROM entries WHERE path = 'same.md'"))
      const lines = rowsOf(file, "SELECT object FROM changes WHERE type = 'write' AND path = 'same.md' ORDER BY seq").map((row) => String(row.object))
      const stale = lines.find((object) => object !== entryObject) as string
      const ids = async () => {
        const found = []
        for await (const object of createFolderByteStore({ root: join(dir, 'bytes') }).list()) found.push(object.id)
        return found
      }
      await backend.sweep({ now: wroteAt + 13 * DAY })
      expect(await ids()).toContain(stale)
      await backend.sweep({ now: wroteAt + 15 * DAY })
      expect(await ids()).not.toContain(stale)
      expect(await ids()).toContain(entryObject)
    } finally {
      backend.close()
    }
  })

  it('takes a refused write’s object after the grace, and not before', async () => {
    const { backend, bytes, id, file } = await started()
    try {
      await put(backend, id, 'n.md', 'one')
      const stale = (await backend.stat(id, 'n.md'))?.version ?? ''
      await put(backend, id, 'n.md', 'two')
      const before = await objectIds(bytes)
      await expect(put(backend, id, 'n.md', 'refused bytes', { ifMatch: stale })).rejects.toMatchObject({ code: 'precondition' })
      const refused = (await objectIds(bytes)).filter((object) => !before.includes(object))
      expect(refused).toHaveLength(1)
      expect(scalar(file, 'SELECT COUNT(*) FROM changes WHERE object = ?', refused[0])).toBe(0)
      const realNow = Date.now()
      // Within the grace (the object was put a moment ago by the real clock) it stays; past it, it goes.
      await backend.sweep({ now: realNow + 5 * MINUTE })
      expect(await objectIds(bytes)).toContain(refused[0])
      const swept = await backend.sweep({ now: realNow + 2 * HOUR })
      expect(swept.removed).toContain(refused[0])
      expect(await objectIds(bytes)).not.toContain(refused[0])
    } finally {
      backend.close()
    }
  })

  it('refuses to sweep a database that is read-only', async () => {
    const { backend, file } = await started()
    backend.close()
    const db = raw(file)
    db.exec('PRAGMA user_version = 3')
    db.close()
    const again = createDatabaseBackend({ file, bytes: createFolderByteStore({ root: join(file, '..', 'bytes') }) })
    try {
      expect(await code(again.sweep())).toBe('read-only')
    } finally {
      again.close()
    }
  })
})

describe('removed projects', () => {
  async function two() {
    const made = make()
    const keep = (await made.backend.createProject({ name: 'Kept' }, { actor: ADA })).id
    const gone = (await made.backend.createProject({ name: 'Going' }, { actor: ADA })).id
    return { ...made, keep, gone }
  }

  it('removeProject hides the project everywhere, ends its feeds after telling remove, drops it from usage and keeps its id taken', async () => {
    const { backend, keep, gone, state } = await two()
    try {
      await put(backend, gone, 'n.md', 'x'.repeat(50))
      await put(backend, keep, 'n.md', 'y'.repeat(30))
      const usageBefore = await backend.usage()
      const goneUsage = await backend.usage(gone)
      const heard: Array<{ type: string; path: string }> = []
      let ended = 0
      await backend.subscribe(gone, { change: (record: (typeof heard)[number]) => heard.push(record), end: () => (ended += 1) })
      state.now = T0 + HOUR
      const removed = await backend.removeProject(gone, { actor: LEAR })
      expect(removed).toMatchObject({ id: gone, name: 'Going', removedBy: { id: 'lear' }, removed: new Date(T0 + HOUR).toISOString(), purgeAfter: new Date(T0 + HOUR + 14 * DAY).toISOString() })
      expect(heard).toMatchObject([{ type: 'remove', path: '' }])
      expect(ended).toBe(1)
      expect((await backend.listProjects()).map((project) => project.id)).toEqual([keep])
      for (const call of [() => backend.project(gone), () => backend.list(gone), () => backend.read(gone, 'n.md'), () => backend.subscribe(gone, { change() {}, end() {} }), () => backend.cursor(gone), () => put(backend, gone, 'm.md', 'x')]) {
        expect(await code(call())).toBe('no-project')
      }
      const usageAfter = await backend.usage()
      expect(goneUsage.bytes).toBeGreaterThan(50)
      expect(usageBefore.bytes - usageAfter.bytes).toBe(goneUsage.bytes)
      expect(usageBefore.files - usageAfter.files).toBe(goneUsage.files)
      expect(usageAfter).toEqual(await backend.usage(keep))
      expect(await code(backend.createProject({ id: gone, name: 'Again' }))).toBe('exists')
      expect((await backend.removedProjects()).map((project) => project.id)).toEqual([gone])
      // Removing it again, or something that was never there, is no-project.
      expect(await code(backend.removeProject(gone))).toBe('no-project')
      expect(await code(backend.removeProject('never-there'))).toBe('no-project')
    } finally {
      backend.close()
    }
  })

  it('restoreProject brings it back whole under a new epoch, logs mkdir of the root, and an old cursor resyncs', async () => {
    const { backend, gone, state } = await two()
    try {
      await put(backend, gone, 'dir/n.md', 'hello')
      const entries = await backend.list(gone)
      const oldCursor = await backend.cursor(gone)
      state.now = T0 + HOUR
      await backend.removeProject(gone, { actor: ADA })
      state.now = T0 + 2 * HOUR
      const back = await backend.restoreProject(gone, { actor: LEAR })
      expect(back).toMatchObject({ id: gone, name: 'Going' })
      expect(await backend.list(gone)).toEqual(entries)
      expect(await textOf(backend, gone, 'dir/n.md')).toBe('hello')
      expect((await backend.listProjects()).map((project) => project.id)).toContain(gone)
      expect(await backend.removedProjects()).toEqual([])
      expect(await backend.changesSince(gone, oldCursor)).toMatchObject({ resync: true })
      const newCursor = await backend.cursor(gone)
      expect(newCursor.split(':')[0]).not.toBe(oldCursor.split(':')[0])
      const last = (await backend.recent({ project: gone, limit: 2 })).changes
      expect(last[0]).toMatchObject({ type: 'mkdir', path: '', actor: { id: 'lear' } })
      expect(last[1]).toMatchObject({ type: 'remove', path: '', actor: { id: 'ada' } })
      // A project that isn't removed can't be "restored".
      expect(await code(backend.restoreProject(gone))).toBe('no-project')
    } finally {
      backend.close()
    }
  })

  it('is purged by the sweep after keepDays and not before: its objects freed, its log kept, and it restores as no-project', async () => {
    const { backend, bytes, keep, gone, state, file } = await two()
    try {
      await put(backend, gone, 'n.md', 'going bytes')
      await put(backend, keep, 'n.md', 'kept bytes')
      const goingObject = String(scalar(file, "SELECT object FROM entries WHERE project = ? AND path = 'n.md'", gone))
      const keptObject = String(scalar(file, "SELECT object FROM entries WHERE project = ? AND path = 'n.md'", keep))
      const logRows = Number(scalar(file, 'SELECT COUNT(*) FROM changes WHERE project = ?', gone))
      state.now = T0
      await backend.removeProject(gone, { actor: ADA })
      const early = await backend.sweep({ now: T0 + 14 * DAY - MINUTE })
      expect(early.purged).toEqual([])
      expect((await backend.removedProjects()).map((project) => project.id)).toEqual([gone])
      const objects = await objectIds(bytes)
      const late = await backend.sweep({ now: T0 + 14 * DAY + MINUTE })
      expect(late.purged).toEqual([gone])
      expect(late.removed.length).toBeGreaterThan(0)
      // Only the removed project's objects went, and the kept one reads on.
      expect((await objectIds(bytes)).length).toBeLessThan(objects.length)
      expect(late.removed).toContain(goingObject)
      expect(await objectIds(bytes)).toContain(keptObject)
      expect(await objectIds(bytes)).not.toContain(goingObject)
      expect(await textOf(backend, keep, 'n.md')).toBe('kept bytes')
      expect(Number(scalar(file, 'SELECT COUNT(*) FROM changes WHERE project = ?', gone))).toBeGreaterThanOrEqual(logRows)
      expect(await backend.removedProjects()).toEqual([])
      expect(await code(backend.restoreProject(gone))).toBe('no-project')
      expect(await code(backend.createProject({ id: gone, name: 'Again' }))).toBe('exists')
    } finally {
      backend.close()
    }
  })
})

describe('a database of a newer schema', () => {
  it('refuses restore, removeProject, restoreProject and sweep with read-only, and still lists and reads versions', async () => {
    const made = await started()
    await put(made.backend, made.id, 'n.md', 'one', { actor: ADA })
    await put(made.backend, made.id, 'n.md', 'two', { actor: LEAR })
    const [, oldest] = (await made.backend.versions(made.id, 'n.md')).versions
    made.backend.close()
    const db = raw(made.file)
    db.exec('PRAGMA user_version = 3')
    db.close()
    const logged: string[] = []
    const backend = createDatabaseBackend({ file: made.file, bytes: createFolderByteStore({ root: join(made.dir, 'bytes') }), log: (message: string) => logged.push(message) })
    try {
      expect(backend.readOnly).toBe(true)
      expect(backend.capabilities).toMatchObject({ removeProject: false, createProject: false })
      expect(logged.length).toBeGreaterThan(0)
      expect(await code(backend.restore(made.id, 'n.md', oldest.version, { ifMatch: (await backend.stat(made.id, 'n.md'))?.version ?? '' }))).toBe('read-only')
      expect(await code(backend.removeProject(made.id))).toBe('read-only')
      expect(await code(backend.restoreProject(made.id))).toBe('read-only')
      expect(await code(backend.sweep())).toBe('read-only')
      expect(await code(put(backend, made.id, 'm.md', 'x'))).toBe('read-only')
      expect((await backend.versions(made.id, 'n.md')).versions).toHaveLength(2)
      expect(await textOf(backend, made.id, 'n.md', oldest.version)).toBe('one')
      expect(await textOf(backend, made.id, 'n.md')).toBe('two')
      expect((await backend.listProjects()).map((project) => project.id)).toEqual([made.id])
    } finally {
      backend.close()
    }
  })
})

describe('a restore and a sweep racing', () => {
  it('answers not-found and writes nothing when thinning drops the version between the restore’s lookup and its transaction', async () => {
    // A migrated 2.0.3 file: its old versions have no size yet, so a restore reads the object first (an await the sweep can fit into).
    const dir = copyOfFixture()
    const inner = createFolderByteStore({ root: join(dir, 'bytes') })
    let hold: { arrived: () => void; release: Promise<void> } | null = null
    const bytes = Object.assign(Object.create(inner), {
      get: async (id: string) => {
        const gate = hold
        if (gate) {
          hold = null
          gate.arrived()
          await gate.release
        }
        return inner.get(id)
      },
    })
    const backend = createDatabaseBackend({ file: join(dir, 'nebula.db'), bytes })
    try {
      // Not asked for yet through `versions`, which would measure them: this restore has to read the object.
      const written = rowsOf(join(dir, 'nebula.db'), "SELECT entry, rev, at FROM changes WHERE project = 'alpha' AND type = 'write' AND path = 'notes/a.md' ORDER BY seq")
      expect(written).toHaveLength(3)
      expect(written.every((row) => row.entry === 6)).toBe(true)
      const target = `${(written[1].entry as number).toString(36)}:${written[1].rev}`
      const stat = await backend.stat('alpha', 'docs/a.md')
      const cursor = await backend.cursor('alpha')
      let arrived!: () => void
      const reached = new Promise<void>((resolve) => (arrived = resolve))
      let open!: () => void
      hold = { arrived, release: new Promise<void>((resolve) => (open = resolve)) }
      const restoring = backend.restore('alpha', 'docs/a.md', target, { actor: LEAR, ifMatch: stat?.version ?? undefined })
      const outcome = restoring.then(() => 'restored', (error: { code?: string }) => error.code)
      await reached
      // While the restore waits on the object, a sweep long after thins the version away (its objects are left, as in a slow sweep).
      const later = Date.parse(String(written[2].at)) + 60 * DAY
      const result = await backend.sweep({ now: later, graceMinutes: 10_000_000 })
      expect(result.dropped).toBeGreaterThan(0)
      open()
      expect(await outcome).toBe('not-found')
      expect(await backend.cursor('alpha')).toBe(cursor)
      expect(await textOf(backend, 'alpha', 'docs/a.md')).toBe('a four, after the rename')
    } finally {
      backend.close()
    }
  })
})
