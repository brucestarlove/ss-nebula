// The exported conformance handed to node:test's own describe and it, as a host without vitest does.
// Run by tests/exportedModules.test.ts with `node --test`.
import { describe, it } from 'node:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { register as registerBackend } from '../../cli/conformance/backend.mjs'
import { register as registerBytes } from '../../cli/conformance/bytes.mjs'
import { createFolderByteStore } from '../../cli/bytes/folder.mjs'
import { createMemoryBackend } from '../../cli/backends/memory.mjs'
import { createDatabaseBackend } from '../../cli/backends/database.mjs'

const parent = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'nebula-node-test-'))
let made = 0
const scratch = () => {
  const dir = join(parent, `case-${(made += 1)}`)
  mkdirSync(dir)
  return dir
}

registerBytes({ describe, it }, 'byte store: folder', () => ({ store: createFolderByteStore({ root: scratch() }) }))
registerBackend({ describe, it }, 'backend: memory', () => ({ backend: createMemoryBackend() }))
// The database backend's arrays and rows come from node:sqlite, with no prototype: the cases compare shapes.
registerBackend({ describe, it }, 'backend: database', () => ({ backend: createDatabaseBackend({ folder: scratch() }) }))
