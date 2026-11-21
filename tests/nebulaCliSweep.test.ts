// @vitest-environment node
// `nebula run --database` sweeps the database: once at start and then every hour, one log line a
// run, never on a database a newer Nebula wrote (it only reads that), and its timer never keeps the
// process alive once the server closes. The server is started by the CLI's own function over a
// scratch folder; the sweep is counted through a wrapper on the backend it makes, and the hour is a
// fake interval timer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanScratch, raw, scratch } from './databaseSupport'

const counted = vi.hoisted(() => ({ folders: [] as string[] }))

vi.mock('../cli/backends/database.mjs', async (importOriginal) => {
  const original = (await importOriginal()) as { createDatabaseBackend: (options: { folder: string }) => { sweep: (...args: unknown[]) => Promise<unknown> } }
  return {
    ...original,
    createDatabaseBackend: (options: { folder: string }) => {
      const backend = original.createDatabaseBackend(options)
      const real = backend.sweep
      backend.sweep = async (...args: unknown[]) => {
        counted.folders.push(options.folder)
        return real(...args)
      }
      return backend
    },
  }
})

const MINUTE = 60 * 1000
const servers: { close: (callback: () => void) => void }[] = []
let lines: string[] = []

beforeEach(() => {
  counted.folders.length = 0
  lines = []
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => void lines.push(String(line)))
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  while (servers.length) await new Promise<void>((resolve) => (servers.pop() as (typeof servers)[number]).close(resolve))
  cleanScratch()
})

/** The built app's stand-in and a database folder (made, so the CLI doesn't announce a new one). */
function places() {
  const root = scratch('cli')
  const app = join(root, 'app')
  const database = join(root, 'database')
  mkdirSync(app)
  mkdirSync(database)
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>Nebula</title>')
  return { app, database }
}

async function start(app: string, database: string) {
  const { startNebulaStaticServer } = await import('../cli/nebula-cli.mjs')
  const running = await startNebulaStaticServer({ host: '127.0.0.1', port: 0, root: app, silent: true, database })
  servers.push(running.server)
  return running
}

/** Polls on the real clock (vi.waitFor would advance the fake one) until `check` holds. */
async function until(check: () => boolean, what: string) {
  for (let waited = 0; !check(); waited += 20) {
    if (waited > 5000) throw new Error(`waited 5 s for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
const settled = (runs: number) => until(() => counted.folders.length === runs, `${runs} sweep(s)`)
const logged = (database: string) => lines.filter((line) => line.includes(database))

describe('nebula run --database sweeps', () => {
  it('once at start and then every hour, a line of the log for each run', async () => {
    const { app, database } = places()
    await start(app, database)
    await settled(1)
    expect(counted.folders).toEqual([database])
    await until(() => logged(database).length === 1, 'the line of the first run')
    // Not before the hour is out…
    vi.advanceTimersByTime(59 * MINUTE)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(counted.folders).toHaveLength(1)
    // …and then once an hour, each run saying so.
    vi.advanceTimersByTime(MINUTE)
    await settled(2)
    await until(() => logged(database).length === 2, 'the line of the second run')
    vi.advanceTimersByTime(60 * MINUTE)
    await settled(3)
    await until(() => logged(database).length === 3, 'the line of the third run')
  })

  it('never on a database a newer Nebula wrote: it only reads that one', async () => {
    const { app, database } = places()
    // A database of a newer schema: made by this code, then marked as the next version's.
    const { createDatabaseBackend } = (await vi.importActual('../cli/backends/database.mjs')) as { createDatabaseBackend: (options: { folder: string }) => { close: () => void } }
    createDatabaseBackend({ folder: database }).close()
    const db = raw(join(database, 'nebula.db'))
    db.exec('PRAGMA user_version = 3')
    db.close()
    const running = await start(app, database)
    expect(running.files).toBeTruthy()
    vi.advanceTimersByTime(3 * 60 * MINUTE)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(counted.folders).toEqual([])
  })
})

describe('the sweep’s timer', () => {
  it('lets the process end when the server closes', async () => {
    vi.useRealTimers()
    const { app, database } = places()
    const script = `
      import { startNebulaStaticServer } from ${JSON.stringify(new URL('../cli/nebula-cli.mjs', import.meta.url).href)}
      const running = await startNebulaStaticServer({ host: '127.0.0.1', port: 0, root: ${JSON.stringify(app)}, silent: true, database: ${JSON.stringify(database)} })
      await new Promise((resolve) => setTimeout(resolve, 300))
      await new Promise((resolve) => running.server.close(resolve))
      console.log('closed')
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    const code = await new Promise<number | string | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve('hung')
      }, 20_000)
      child.on('exit', (status) => {
        clearTimeout(timer)
        resolve(status)
      })
    })
    expect(out).toContain('closed')
    expect(code).toBe(0)
  })
})
