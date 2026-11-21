// @vitest-environment node
// The shared conformance (cli/conformance/), run on every store and backend Nebula ships: the same
// cases the Suite runs against its bucket store and its database backend over it. Each case makes
// a store or backend of its own in a scratch folder under TMPDIR, and removes it after.
import { afterAll, describe, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { register as registerBackend } from '../cli/conformance/backend.mjs'
import { register as registerBytes } from '../cli/conformance/bytes.mjs'
import { createFolderBackend } from '../cli/backends/folder.mjs'
import { createMemoryBackend } from '../cli/backends/memory.mjs'
import { createDatabaseBackend } from '../cli/backends/database.mjs'
import { createFolderByteStore } from '../cli/bytes/folder.mjs'

const parent = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'nebula-conformance-'))
let made = 0

afterAll(() => rmSync(parent, { recursive: true, force: true }))

/** A scratch folder for one case, and what removes it. */
function scratch() {
  const dir = join(parent, `case-${(made += 1)}`)
  mkdirSync(dir)
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

registerBytes({ describe, it }, 'byte store: folder', () => {
  const { dir, dispose } = scratch()
  return { store: createFolderByteStore({ root: dir }), dispose }
})

registerBackend({ describe, it }, 'backend: folders', () => {
  const { dir, dispose } = scratch()
  return { backend: createFolderBackend({ projectsDirs: [dir] }), dispose }
})

registerBackend({ describe, it }, 'backend: memory', () => ({ backend: createMemoryBackend() }))

registerBackend({ describe, it }, 'backend: database, over the folder byte store', () => {
  const { dir, dispose } = scratch()
  return { backend: createDatabaseBackend({ folder: dir }), dispose }
})
