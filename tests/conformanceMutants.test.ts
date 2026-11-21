// @vitest-environment node
// The conformance bites: `byteStoreCases` and `backendCases` (cli/conformance/) run against stores and
// backends made faulty on purpose, one fault each, and every one must fail at least one case. A
// conformance that a broken backend passes holds a host to nothing. The same cases pass the
// unbroken ones (tests/conformance.test.ts), which is the control here too.
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backendCases } from '../cli/conformance/backend.mjs'
import { byteStoreCases } from '../cli/conformance/bytes.mjs'
import { createMemoryBackend } from '../cli/backends/memory.mjs'
import { createDatabaseBackend } from '../cli/backends/database.mjs'
import { createFolderByteStore } from '../cli/bytes/folder.mjs'

const parent = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'nebula-mutants-'))
let made = 0
afterAll(() => rmSync(parent, { recursive: true, force: true }))

function scratch() {
  const dir = join(parent, `case-${(made += 1)}`)
  mkdirSync(dir)
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any
/** The object without one key. */
const without = (value: Any, key: string): Any => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))
const layer = (base: Any, over: Record<string, unknown>): Any => Object.assign(Object.create(base), over)

/** The first case a run fails, or null when every case passes. Stops there: one is enough to bite. */
async function firstFailure(cases: { name: string; run: () => Promise<void> }[]): Promise<string | null> {
  for (const { name, run } of cases) {
    try {
      await run()
    } catch {
      return name
    }
  }
  return null
}

/** Every case a run fails. */
async function failures(cases: { name: string; run: () => Promise<void> }[]): Promise<string[]> {
  const failed: string[] = []
  for (const { name, run } of cases) {
    try {
      await run()
    } catch {
      failed.push(name)
    }
  }
  return failed
}

const bytesFaults: Record<string, (store: Any) => Any> = {
  'a put that answers a size one too large': (store) => layer(store, { put: async (...args: Any[]) => { const put = await store.put(...args); return { ...put, size: put.size + 1 } } }),
  'a put that answers another sha256': (store) => layer(store, { put: async (...args: Any[]) => ({ ...(await store.put(...args)), sha256: '0'.repeat(64) }) }),
  'a put that ignores maxBytes': (store) => layer(store, { put: (body: Any) => store.put(body) }),
  'a list whose `at` is in seconds': (store) => layer(store, { list: async function* () { for await (const object of store.list()) yield { ...object, at: Math.floor(object.at / 1000) } } }),
  'a get of an id that was never made that answers empty bytes': (store) => layer(store, { get: async (id: string) => { try { return await store.get(id) } catch { return new Response(new Uint8Array(0)).body } } }),
  'a delete of a missing object that rejects': (store) => layer(store, { delete: async (id: string) => { if (!(await (async () => { for await (const object of store.list()) if (object.id === id) return true; return false })())) throw new Error('no such object'); return store.delete(id) } }),
  'a list that skips an object': (store) => layer(store, { list: async function* () { let first = true; for await (const object of store.list()) { if (first) { first = false; continue } yield object } } }),
  'a store that puts every object under one id once there is one': (store) => {
    let first: { id: string } | undefined
    return layer(store, { put: async (...args: Any[]) => { const result = await store.put(...args); const kept = (first ??= result); return { ...result, id: kept.id } } })
  },
}

describe('the byte store cases bite', () => {
  it('pass the folder store, the control', async () => {
    const cases = byteStoreCases(() => {
      const { dir, dispose } = scratch()
      return { store: createFolderByteStore({ root: dir }), dispose }
    })
    expect(await firstFailure(cases)).toBeNull()
  })

  for (const [fault, make] of Object.entries(bytesFaults)) {
    it(`fail on ${fault}`, async () => {
      const cases = byteStoreCases(() => {
        const { dir, dispose } = scratch()
        return { store: make(createFolderByteStore({ root: dir })), dispose }
      })
      expect(await firstFailure(cases), fault).not.toBeNull()
    })
  }
})

/** Faults in a memory backend: what the cases about the basic rules must notice. */
const memoryFaults: Record<string, (backend: Any) => Any> = {
  'a write that ignores ifMatch': (b) => layer(b, { write: (id: string, path: string, body: Any, options: Any = {}) => b.write(id, path, body, { ...options, ifMatch: undefined }) }),
  'a write that ignores ifAbsent': (b) => layer(b, { write: (id: string, path: string, body: Any, options: Any = {}) => b.write(id, path, body, { ...options, ifAbsent: false }) }),
  'a write that ignores parents: false': (b) => layer(b, { write: (id: string, path: string, body: Any, options: Any = {}) => b.write(id, path, body, { ...options, parents: true }) }),
  'a rename that overwrites its target': (b) => layer(b, { rename: async (id: string, from: string, to: string, author: Any) => { await b.remove(id, to).catch(() => {}); return b.rename(id, from, to, author) } }),
  'a rename of a file that is a copy with a new version': (b) =>
    layer(b, {
      rename: async (id: string, from: string, to: string, author: Any) => {
        const file = await b.read(id, from)
        await b.write(id, to, file.body, author)
        return b.remove(id, from, author)
      },
    }),
  'a folder remove that leaves the folders': (b) =>
    layer(b, {
      remove: async (id: string, path: string, author: Any) => {
        const found = await b.stat(id, path)
        if (found?.entry.type !== 'dir') return b.remove(id, path, author)
        for (const entry of await b.list(id)) if (entry.type === 'file' && entry.path.startsWith(`${path}/`)) await b.remove(id, entry.path, author)
        return { cursor: await b.cursor(id) }
      },
    }),
  'a subscription that can’t be stopped': (b) => layer(b, { subscribe: async (id: string, subscriber: Any) => { await b.subscribe(id, subscriber); return () => {} } }),
  'a list that shows .nebula': (b) => layer(b, { list: async (id: string) => [...(await b.list(id)), { path: '.nebula/project.json', name: 'project.json', type: 'file', size: 1, modified: 0, version: 'x:1' }] }),
  'a list of a project that isn’t there that answers empty': (b) => layer(b, { list: async (id: string) => { try { return await b.list(id) } catch { return [] } } }),
  'a usage that counts every byte ever written': (b) => {
    const ghost = new Map<string, number>()
    return layer(b, {
      write: async (id: string, path: string, body: Any, options: Any) => {
        const before = await b.stat(id, path)
        if (before?.entry.size) ghost.set(id, (ghost.get(id) ?? 0) + before.entry.size)
        return b.write(id, path, body, options)
      },
      usage: async (id?: string) => {
        const usage = await b.usage(id)
        return { ...usage, bytes: usage.bytes + (id === undefined ? [...ghost.values()].reduce((a, c) => a + c, 0) : (ghost.get(id) ?? 0)) }
      },
    })
  },
  'a cursor that doesn’t move on a write': (b) => layer(b, { cursor: async (id: string) => (await b.changesSince(id, '')).cursor.replace(/:\d+$/, ':0') }),
}

describe('the backend cases bite: the rules every backend keeps', () => {
  it('pass the memory backend, the control', async () => {
    expect(await firstFailure(backendCases(() => ({ backend: createMemoryBackend() })))).toBeNull()
  })

  for (const [fault, make] of Object.entries(memoryFaults)) {
    it(`fail on ${fault}`, async () => {
      expect(await firstFailure(backendCases(() => ({ backend: make(createMemoryBackend()) }))), fault).not.toBeNull()
    })
  }
})

/** Faults in a backend that keeps history (over the database backend), each with a word of the case that must notice it. */
const historyFaults: [string, string, (b: Any) => Any][] = [
  ['versions that list the oldest first', 'versions lists', (b) => layer(b, { versions: async (...a: Any[]) => { const page = await b.versions(...a); return { ...page, versions: [...page.versions].reverse() } } })],
  ['versions with no current one', 'versions lists', (b) => layer(b, { versions: async (...a: Any[]) => { const page = await b.versions(...a); return { ...page, versions: page.versions.map((v: Any) => ({ ...v, current: false })) } } })],
  ['versions with a wrong size', 'versions lists', (b) => layer(b, { versions: async (...a: Any[]) => { const page = await b.versions(...a); return { ...page, versions: page.versions.map((v: Any) => ({ ...v, size: 0 })) } } })],
  ['versions that ignore before', 'versions pages', (b) => layer(b, { versions: (id: string, path: string, options: Any = {}) => b.versions(id, path, { ...options, before: undefined }) })],
  ['versions that answer an empty history for a path no file was at', 'versions lists', (b) => layer(b, { versions: async (id: string, path: string, options: Any) => { try { return await b.versions(id, path, options) } catch { return { versions: [], next: null } } } })],
  ['a readVersion that gives the current bytes', 'readVersion gives', (b) => layer(b, { readVersion: (id: string, path: string) => b.read(id, path) })],
  ['a readVersion that never says not-found', 'readVersion gives', (b) => layer(b, { readVersion: async (id: string, path: string, version: string) => { try { return await b.readVersion(id, path, version) } catch (error: Any) { if (error.code === 'not-found') return b.read(id, path); throw error } } })],
  ['a restore that ignores ifMatch', 'restore names', (b) => layer(b, { restore: (id: string, path: string, version: string, options: Any = {}) => b.restore(id, path, version, { ...options, ifMatch: undefined }) })],
  ['a restore that ignores ifAbsent', 'restore names', (b) => layer(b, { restore: (id: string, path: string, version: string, options: Any = {}) => b.restore(id, path, version, { ...options, ifAbsent: false }) })],
  ['a restore that doesn’t say what it restored', 'restore brings', (b) => layer(b, { changesSince: async (id: string, since: string) => { const answer = await b.changesSince(id, since); return answer.changes ? { ...answer, changes: answer.changes.map((record: Any) => without(record, 'restoredFrom')) } : answer } })],
  ['a restore that doesn’t leave the replaced version readable', 'restore brings', (b) => layer(b, { readVersion: async (id: string, path: string, version: string) => { const [current] = (await b.versions(id, path)).versions; if (current?.restoredFrom && version !== current.version && version !== current.restoredFrom) { const { default: assert } = await import('node:assert/strict'); assert.fail('gone') } return b.readVersion(id, path, version) } })],
  ['a save of identical bytes that makes a revision', 'a save of the bytes', (b) => layer(b, { write: async (id: string, path: string, body: Any, options: Any) => { await b.write(id, path, (async function* () { yield new TextEncoder().encode(`${Math.random()}`) })(), options); return b.write(id, path, body, options) } })],
  ['a sweep after which only the current version is kept', 'thinning keeps', (b) => {
    let swept = false
    return layer(b, { sweep: async (...a: Any[]) => { swept = true; return b.sweep(...a) }, versions: async (...a: Any[]) => { const page = await b.versions(...a); return swept ? { ...page, versions: page.versions.filter((v: Any) => v.current) } : page } })
  }],
  ['a sweep that takes records from the log', 'thinning keeps', (b) => {
    let swept = false
    return layer(b, { sweep: async (...a: Any[]) => { swept = true; return b.sweep(...a) }, changesSince: async (id: string, since: string) => { const answer = await b.changesSince(id, since); return swept && answer.changes ? { ...answer, changes: answer.changes.slice(1) } : answer } })
  }],
  ['a removed project that still lists', 'removeProject takes', (b) => {
    const infos = new Map<string, Any>()
    return layer(b, {
      removeProject: async (id: string, options: Any) => { infos.set(id, await b.project(id)); return b.removeProject(id, options) },
      listProjects: async () => [...(await b.listProjects()), ...infos.values()],
    })
  }],
  ['a removed project whose feeds don’t end', 'removeProject takes', (b) => layer(b, { subscribe: (id: string, subscriber: Any) => b.subscribe(id, { ...subscriber, end() {} }) })],
  ['a removed project that is still counted in usage', 'removeProject takes', (b) => {
    const kept = new Map<string, Any>()
    return layer(b, {
      removeProject: async (id: string, options: Any) => { kept.set(id, await b.usage(id)); return b.removeProject(id, options) },
      usage: async (id?: string) => { const usage = await b.usage(id); return id === undefined ? { bytes: usage.bytes + [...kept.values()].reduce((a, c) => a + c.bytes, 0), files: usage.files + [...kept.values()].reduce((a, c) => a + c.files, 0) } : usage },
    })
  }],
  ['a removed project that doesn’t say who removed it', 'removeProject takes', (b) => layer(b, { removedProjects: async () => (await b.removedProjects()).map((each: Any) => without(each, 'removedBy')) })],
  ['a restored project whose old cursor still works', 'restoreProject brings', (b) => {
    const restored = new Set<string>()
    return layer(b, {
      restoreProject: async (id: string, options: Any) => { restored.add(id); return b.restoreProject(id, options) },
      changesSince: async (id: string, since: string) => (restored.has(id) ? { cursor: await b.cursor(id), changes: [] } : b.changesSince(id, since)),
    })
  }],
  ['a restored project with no record of it', 'restoreProject brings', (b) => layer(b, { recent: async (query: Any) => { const page = await b.recent(query); return { ...page, changes: page.changes.filter((c: Any) => !(c.type === 'mkdir' && c.path === '')) } } })],
  ['a restore of a project that wasn’t removed', 'restoreProject brings', (b) => layer(b, { restoreProject: async (id: string, options: Any) => { try { return await b.restoreProject(id, options) } catch (error: Any) { if (error.code === 'no-project') return b.project(id); throw error } } })],
]

describe('the backend cases bite: the History cases', () => {
  const make = (fault?: (b: Any) => Any) => () => {
    const { dir, dispose } = scratch()
    const backend = createDatabaseBackend({ folder: dir })
    return { backend: fault ? fault(backend) : backend, dispose }
  }

  it('pass the database backend, the control, and leave out what a backend without history doesn’t claim', { timeout: 120_000 }, async () => {
    expect(await firstFailure(backendCases(make()))).toBeNull()
    const memory = backendCases(() => ({ backend: createMemoryBackend() }))
    const needing = memory.filter((each: Any) => each.needs === 'versions' || each.needs === 'removeProject')
    expect(needing.length).toBeGreaterThanOrEqual(9)
    for (const each of needing) await each.run()
  })

  for (const [fault, word, wrap] of historyFaults) {
    it(`fail on ${fault}, in a case about it`, async () => {
      // Only the History cases: the others have their own faults above.
      const history = backendCases(make(wrap)).filter((each: Any) => each.needs === 'versions' || each.needs === 'removeProject')
      expect(history.length).toBeGreaterThanOrEqual(9)
      const failed = await failures(history)
      expect(failed.length, fault).toBeGreaterThan(0)
      expect(failed.some((name) => name.includes(word)), `${fault}: failed ${JSON.stringify(failed)}`).toBe(true)
    })
  }
})
