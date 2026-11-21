// What the database backend's tests share: scratch folders, a body to write, the two actors, and a
// plain look into a database file with node:sqlite (loaded as the backend loads it, so Vite never
// resolves it). Not a test file: vitest runs only *.test.* files.
import { createRequire } from 'node:module'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const DAY = 24 * 60 * 60 * 1000
export const HOUR = 60 * 60 * 1000
export const MINUTE = 60 * 1000
export const ADA = { type: 'human', id: 'ada', name: 'Ada' } as const
export const LEAR = { type: 'agent', id: 'lear', name: 'Lear' } as const
/** A fixed "now" for the tests that simulate days: midnight UTC, so the thinning marks are round. */
export const T0 = Date.parse('2026-12-01T00:00:00.000Z')
export const FIXTURE_203 = join(import.meta.dirname, 'fixtures', 'database-2.0.3')

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (file: string, options: { readOnly: boolean }) => RawDatabase }

export interface RawDatabase {
  exec: (sql: string) => void
  prepare: (sql: string) => { all: (...args: unknown[]) => Record<string, unknown>[]; get: (...args: unknown[]) => Record<string, unknown> | undefined; run: (...args: unknown[]) => unknown }
  close: () => void
}

/** The backend as these tests call it: its JSDoc types are strict about options the cases leave out. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Backend = any

const parents: string[] = []

/** A scratch folder under TMPDIR; `cleanScratch` removes every one made. */
export function scratch(name = 'case'): string {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), `nebula-db-${name}-`))
  parents.push(root)
  return root
}

export function cleanScratch(): void {
  while (parents.length) rmSync(parents.pop() as string, { recursive: true, force: true })
}

/** A copy of 2.0.3's checked-in database (made once by 2.0.3's own backend): the fixture itself is never opened. */
export function copyOfFixture(): string {
  const dir = join(scratch('fixture'), 'db')
  mkdirSync(dir)
  cpSync(FIXTURE_203, dir, { recursive: true })
  return dir
}

/** A body of one chunk. */
export function body(content: string | Uint8Array): AsyncIterable<Uint8Array> {
  const chunk = typeof content === 'string' ? new TextEncoder().encode(content) : content
  return (async function* () {
    yield chunk
  })()
}

/** A file's bytes through `read`, or `readVersion` when a version is given. */
export async function bytesOf(backend: Backend, id: string, path: string, version?: string): Promise<Uint8Array> {
  const file = version === undefined ? await backend.read(id, path) : await backend.readVersion(id, path, version)
  return new Uint8Array(await new Response(file.body as ReadableStream).arrayBuffer())
}

export async function textOf(backend: Backend, id: string, path: string, version?: string): Promise<string> {
  return new TextDecoder().decode(await bytesOf(backend, id, path, version))
}

export type Author = { actor?: typeof ADA | typeof LEAR; context?: string }

export const put = (backend: Backend, id: string, path: string, content: string | Uint8Array, options: Record<string, unknown> = {}) => backend.write(id, path, body(content), options)

/** Every object the byte store holds, by id. */
export async function objectIds(bytes: { list: () => AsyncIterable<{ id: string }> }): Promise<string[]> {
  const ids: string[] = []
  for await (const object of bytes.list()) ids.push(object.id)
  return ids.sort()
}

/** Opens a database file for a look with SQL. The wait for a lock is set first: node:sqlite waits for none. */
export function raw(file: string, { readOnly = false } = {}): RawDatabase {
  const db = new DatabaseSync(file, { readOnly })
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

/** Rows as plain objects (node:sqlite gives them no prototype). */
export function rowsOf(file: string, sql: string, ...args: unknown[]): Record<string, unknown>[] {
  const db = raw(file, { readOnly: true })
  try {
    return db.prepare(sql).all(...args).map((row) => ({ ...row }))
  } finally {
    db.close()
  }
}

export const scalar = (file: string, sql: string, ...args: unknown[]): unknown => {
  const [row] = rowsOf(file, sql, ...args)
  return row && Object.values(row)[0]
}
