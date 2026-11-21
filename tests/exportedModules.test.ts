// @vitest-environment node
// What a host's CI relies on in the exported conformance: the modules need no node:sqlite (so they
// run on Node 20.19) and the cases hold under node:test as under vitest. The first runs the byte
// store and the folder and memory backends' cases in a child with `node:sqlite` made unimportable
// and, where NEBULA_NODE20 names a Node 20.19 binary, under that Node too (as CI does).
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const support = join(import.meta.dirname, 'support')
const block = join(support, 'blockSqlite.mjs')
const node20 = process.env.NEBULA_NODE20

const run = (node: string, args: string[]) => spawnSync(node, args, { encoding: 'utf8', timeout: 240_000 })
const summary = (stdout: string) => JSON.parse(stdout.trim().split('\n').at(-1) as string) as { node: string; ran: number; failed: string[]; sqliteLoaded: boolean }

describe('the exported conformance modules', () => {
  it('make node:sqlite unimportable in the child (the control), and a module that imports it fails there', () => {
    const control = run(process.execPath, ['--import', block, '--input-type=module', '-e', "await import('node:sqlite')"])
    expect(control.status).not.toBe(0)
    expect(control.stderr).toContain('node:sqlite was imported')
    const database = run(process.execPath, ['--import', block, '--input-type=module', '-e', `await import(${JSON.stringify(new URL('../cli/backends/database.mjs', import.meta.url).href)}).then((module) => module.createDatabaseBackend({ folder: process.env.TMPDIR + '/no-sqlite-probe' }))`])
    expect(database.status).not.toBe(0)
  })

  it('load with no node:sqlite and pass the byte store, folder and memory backend cases', { timeout: 300_000 }, () => {
    const result = run(process.execPath, ['--import', block, join(support, 'exportedModules.mjs')])
    expect(result.status, result.stderr).toBe(0)
    const answer = summary(result.stdout)
    expect(answer.failed).toEqual([])
    expect(answer.ran).toBeGreaterThan(100)
    expect(answer.sqliteLoaded).toBe(false)
  })

  it.skipIf(!node20)('do the same on Node 20.19 itself, when NEBULA_NODE20 names it', { timeout: 300_000 }, () => {
    const result = run(node20 as string, [join(support, 'exportedModules.mjs')])
    expect(result.status, result.stderr).toBe(0)
    const answer = summary(result.stdout)
    expect(answer.node).toMatch(/^20\./)
    expect(answer.failed).toEqual([])
    expect(answer.sqliteLoaded).toBe(false)
  })

  it('hold under node:test, with every case of the byte store, the memory and the database backends passing', { timeout: 300_000 }, () => {
    const result = run(process.execPath, ['--test', '--test-reporter=tap', join(support, 'conformanceNodeTest.mjs')])
    expect(result.status, result.stdout.slice(-2000)).toBe(0)
    expect(result.stdout).toMatch(/^# fail 0$/m)
    const passed = Number(/^# pass (\d+)$/m.exec(result.stdout)?.[1])
    expect(passed).toBeGreaterThan(100)
  })
})
