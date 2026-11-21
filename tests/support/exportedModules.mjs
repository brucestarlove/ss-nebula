// What a host's CI does with the exported conformance on Node 20.19: import the modules that need
// no node:sqlite and run the byte store cases and the folder backend's. Prints one JSON line.
// Run by tests/exportedModules.test.ts, under this Node (with node:sqlite made unimportable) and,
// where NEBULA_NODE20 names a Node 20.19, under that one.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { byteStoreCases } from '../../cli/conformance/bytes.mjs'
import { backendCases } from '../../cli/conformance/backend.mjs'
import { createFolderByteStore } from '../../cli/bytes/folder.mjs'
import { createFolderBackend } from '../../cli/backends/folder.mjs'
import { createMemoryBackend } from '../../cli/backends/memory.mjs'

const parent = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'nebula-exported-'))
let made = 0
const scratch = () => {
  const dir = join(parent, `case-${(made += 1)}`)
  mkdirSync(dir)
  return dir
}

const failed = []
let ran = 0
async function runAll(cases) {
  for (const { name, run } of cases) {
    ran += 1
    try {
      await run()
    } catch (error) {
      failed.push(`${name}: ${error?.message}`)
    }
  }
}

try {
  await runAll(byteStoreCases(() => ({ store: createFolderByteStore({ root: scratch() }) })))
  await runAll(backendCases(() => ({ backend: createFolderBackend({ projectsDirs: [scratch()] }) })))
  await runAll(backendCases(() => ({ backend: createMemoryBackend() })))
} finally {
  rmSync(parent, { recursive: true, force: true })
}
const sqliteLoaded = process.moduleLoadList.some((entry) => /sqlite/i.test(entry))
console.log(JSON.stringify({ node: process.versions.node, ran, failed, sqliteLoaded }))
process.exit(failed.length ? 1 : 0)
