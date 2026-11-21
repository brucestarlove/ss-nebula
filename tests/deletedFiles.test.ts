// @vitest-environment node
// Deleted files, end to end: the database backend behind the real file API over HTTP, asked through
// HttpFileStore (as Settings → Recently deleted asks it). A file or folder deleted lists the files
// that can come back, and Restore puts one back from the version before the delete, over nothing:
// a path that is taken now is refused, never written over. The clock is the test's own, so days pass.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFilesApi } from '../cli/nebula-files.mjs'
import { createDatabaseBackend } from '../cli/backends/database.mjs'
import { createMemoryBackend } from '../cli/backends/memory.mjs'
import { HttpFileStore, ServerError } from '../src/files/serverStore'
import { FileChangedError } from '../src/files/errors'
import { hasDeletedFiles } from '../src/files/history'

const DAY = 24 * 60 * 60 * 1000
let now = Date.parse('2026-11-01T10:00:00Z')
const clock = () => now
const minutes = (count: number) => void (now += count * 60 * 1000)

let dir = ''
let backend: ReturnType<typeof createDatabaseBackend>
let memory: ReturnType<typeof createMemoryBackend>
type Served = { handle: (req: unknown, res: unknown) => Promise<boolean>; close: () => void }
const apis: Served[] = []
const servers: ReturnType<typeof createServer>[] = []
let base = ''
let memoryBase = ''
let foldersBase = ''
let made = 0

async function listen(files: Served): Promise<string> {
  const server = createServer((req, res) => {
    void files.handle(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  apis.push(files)
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

beforeAll(async () => {
  dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'nebula-deleted-files-'))
  backend = createDatabaseBackend({ folder: dir, clock })
  base = await listen(createFilesApi({ backend, label: 'test-server' }))
  mkdirSync(join(dir, 'folders'))
  foldersBase = await listen(createFilesApi({ projectsDirs: [join(dir, 'folders')], label: 'test-server' }))
  memory = createMemoryBackend()
  memoryBase = await listen(createFilesApi({ backend: memory, label: 'test-server' }))
})

afterAll(async () => {
  for (const files of apis) files.close()
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  rmSync(dir, { recursive: true, force: true })
})

/** A new project on the database server, opened as the app opens it. */
async function open() {
  const project = await backend.createProject({ name: `p${(made += 1)}` })
  const store = await HttpFileStore.open({ base, projectId: project.id, label: 'test-server', graceMs: 50 })
  return { id: project.id, store }
}

const text = async (store: HttpFileStore, path: string) => store.readText(path)
const paths = async (store: HttpFileStore) => (await store.deletedFiles()).files.map((file) => file.path)

beforeEach(() => minutes(1))

describe('deleted files: what the list holds', () => {
  it('lists a deleted file with its last version, size, when and who, and a file still there is not listed', async () => {
    const { store } = await open()
    await store.write('keep.md', 'still here')
    await store.write('gone.md', 'first')
    minutes(1)
    await store.write('gone.md', 'the last words')
    minutes(1)
    await store.remove('gone.md')

    const { files, more } = await store.deletedFiles()

    expect(more).toBe(false)
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('gone.md')
    expect(files[0].size).toBe('the last words'.length)
    expect(files[0].deletedAt).toBe(new Date(now).toISOString())
    expect(files[0].deletedBy?.type).toBe('human')
    // The version it names is the last the file had, not an earlier one.
    expect(await (await store.readVersion('gone.md', files[0].version)).text()).toBe('the last words')
  })

  it('names an agent that deleted it, and lists the newest delete first', async () => {
    const { id, store } = await open()
    await store.write('older.md', 'o')
    await store.write('newer.md', 'n')
    await store.remove('older.md')
    minutes(5)
    const response = await fetch(`${base}/nebula-api/v1/projects/${id}/file?path=newer.md`, { method: 'DELETE', headers: { 'nebula-actor': 'agent', 'nebula-agent-name': 'Lear' } })
    expect(response.status).toBe(200)

    const { files } = await store.deletedFiles()

    expect(files.map((file) => file.path)).toEqual(['newer.md', 'older.md'])
    expect(files[0].deletedBy).toMatchObject({ type: 'agent', name: 'Lear' })
  })

  it('lists the files that were in a deleted folder, however deep, and not the folders, and not what was elsewhere', async () => {
    const { store } = await open()
    await store.write('notes/a.md', 'a')
    await store.write('notes/deep/er/b.md', 'b')
    await store.mkdir('notes/empty')
    await store.write('other/c.md', 'c')
    minutes(1)
    await store.remove('notes')

    expect((await paths(store)).sort()).toEqual(['notes/a.md', 'notes/deep/er/b.md'])
  })

  it('lists every file of a folder deleted at once, though two of them share the same stored bytes', async () => {
    const { store } = await open()
    await store.write('d/a.md', 'the same bytes')
    await store.rename('d/a.md', 'd/b.md')
    // The version of the file that was a.md comes back at a.md as a new file over the same stored bytes.
    const [kept] = (await store.versions('d/a.md')).versions
    await store.restore('d/a.md', kept.version, { ifAbsent: true })
    await store.write('d/c.md', 'the same bytes')
    await store.remove('d')

    const { files } = await store.deletedFiles()

    expect(files.map((file) => file.path).sort()).toEqual(['d/a.md', 'd/b.md', 'd/c.md'])
    // Each comes back with its bytes.
    for (const file of files) expect(await (await store.readVersion(file.path, file.version)).text()).toBe('the same bytes')
  })

  it('does not list a file made again at the same path, nor one whose path is a folder now', async () => {
    const { store } = await open()
    await store.write('again.md', 'before')
    await store.write('folder-now', 'was a file')
    await store.write('listed.md', 'x')
    await store.remove('again.md')
    await store.remove('folder-now')
    await store.remove('listed.md')
    await store.write('again.md', 'after')
    await store.mkdir('folder-now')

    expect(await paths(store)).toEqual(['listed.md'])
  })

  it('lists a path deleted twice once, with the version the latest file there had', async () => {
    const { store } = await open()
    await store.write('twice.md', 'the first file')
    await store.remove('twice.md')
    minutes(1)
    await store.write('twice.md', 'a second file, new')
    await store.remove('twice.md')

    const { files } = await store.deletedFiles()

    expect(files.map((file) => file.path)).toEqual(['twice.md'])
    expect(await (await store.readVersion('twice.md', files[0].version)).text()).toBe('a second file, new')
  })

  it('lists a file once when it was deleted, restored and deleted again', async () => {
    const { store } = await open()
    await store.write('back.md', 'content')
    await store.remove('back.md')
    const [first] = (await store.deletedFiles()).files
    await store.restore('back.md', first.version, { ifAbsent: true })
    minutes(1)
    await store.remove('back.md')

    expect(await paths(store)).toEqual(['back.md'])
  })

  it('drops a delete after the days history is kept (14), and keeps one a day before', async () => {
    const { store } = await open()
    await store.write('old.md', 'old')
    await store.remove('old.md')
    now += 13 * DAY
    await store.write('recent.md', 'recent')
    await store.remove('recent.md')
    expect((await paths(store)).sort()).toEqual(['old.md', 'recent.md'])

    now += 2 * DAY

    expect(await paths(store)).toEqual(['recent.md'])
  })

  it('does not list the project’s own files under .nebula, only the person’s', async () => {
    const { store } = await open()
    await store.write('.nebula/settings.json', '{}')
    await store.write('mine.md', 'm')
    await store.remove('.nebula/settings.json')
    await store.remove('mine.md')

    expect(await paths(store)).toEqual(['mine.md'])
  })

  it('is each project’s own', async () => {
    const one = await open()
    const two = await open()
    await one.store.write('mine.md', 'm')
    await one.store.remove('mine.md')

    expect(await paths(one.store)).toEqual(['mine.md'])
    expect(await paths(two.store)).toEqual([])
  })

  it('holds back the oldest past a limit and says there are more', async () => {
    const { store } = await open()
    for (const name of ['a', 'b', 'c']) {
      await store.write(`${name}.md`, name)
      await store.remove(`${name}.md`)
      minutes(1)
    }

    const page = await store.deletedFiles({ limit: 2 })

    expect(page.files.map((file) => file.path)).toEqual(['c.md', 'b.md'])
    expect(page.more).toBe(true)
    expect((await store.deletedFiles({ limit: 3 })).more).toBe(false)
  })

  it('refuses a limit that is not a whole number from 1 to 500', async () => {
    const { id } = await open()
    for (const limit of ['0', '501', '1.5', 'x']) {
      const response = await fetch(`${base}/nebula-api/v1/projects/${id}/deleted?limit=${limit}`)
      expect(response.status, limit).toBe(400)
    }
  })
})

describe('deleted files: restoring one', () => {
  it('puts the file back at its path with its bytes, in the tree, and the list drops it', async () => {
    const { store } = await open()
    await store.write('back.md', 'v1')
    minutes(1)
    await store.write('back.md', 'v2: what was there at the delete')
    await store.remove('back.md')
    const [file] = (await store.deletedFiles()).files

    const entry = await store.restore(file.path, file.version, { ifAbsent: true })

    expect(entry.path).toBe('back.md')
    expect(await text(store, 'back.md')).toBe('v2: what was there at the delete')
    expect((await store.list()).some((each) => each.path === 'back.md' && each.type === 'file')).toBe(true)
    expect(await paths(store)).toEqual([])
  })

  it('makes the folders it needs when the file was deleted with its folder, and brings back the rest one by one', async () => {
    const { store } = await open()
    await store.write('notes/deep/a.md', 'a')
    await store.write('notes/b.md', 'b')
    await store.remove('notes')
    const before = (await store.list()).map((entry) => entry.path)
    expect(before).not.toContain('notes')
    const deep = (await store.deletedFiles()).files.find((file) => file.path === 'notes/deep/a.md')!

    await store.restore(deep.path, deep.version, { ifAbsent: true })

    const tree = await store.list()
    expect(tree.find((entry) => entry.path === 'notes')?.type).toBe('dir')
    expect(tree.find((entry) => entry.path === 'notes/deep')?.type).toBe('dir')
    expect(await text(store, 'notes/deep/a.md')).toBe('a')
    expect(await paths(store)).toEqual(['notes/b.md'])
  })

  it('refuses a path that is taken now, with 412, and leaves what is there as it is', async () => {
    const { id, store } = await open()
    await store.write('taken.md', 'the deleted one')
    await store.remove('taken.md')
    const [file] = (await store.deletedFiles()).files
    // Someone makes the path again after the list was read.
    await store.write('taken.md', 'someone else’s new file')

    await expect(store.restore(file.path, file.version, { ifAbsent: true })).rejects.toBeInstanceOf(FileChangedError)

    expect(await text(store, 'taken.md')).toBe('someone else’s new file')
    // The API's own answer is 412 `precondition`.
    const response = await fetch(`${base}/nebula-api/v1/projects/${id}/restore?path=taken.md&version=${encodeURIComponent(file.version)}`, { method: 'POST', headers: { 'if-none-match': '*' } })
    expect(response.status).toBe(412)
    expect((await response.json()).error).toBe('precondition')
    expect(await text(store, 'taken.md')).toBe('someone else’s new file')
  })

  it('refuses at the backend too: a restore into a taken path, from a version of another file that was there, is a precondition and writes nothing', async () => {
    const { id, store } = await open()
    await store.write('swap.md', 'the old file')
    await store.remove('swap.md')
    const [file] = (await store.deletedFiles()).files
    await store.write('swap.md', 'the new file')

    await expect(backend.restore(id, 'swap.md', file.version, { ifAbsent: true })).rejects.toMatchObject({ code: 'precondition' })

    expect(await text(store, 'swap.md')).toBe('the new file')
  })

  it('never writes over a file: a restore that names no condition is refused', async () => {
    const { id, store } = await open()
    await store.write('plain.md', 'one')
    await store.remove('plain.md')
    const [file] = (await store.deletedFiles()).files

    const response = await fetch(`${base}/nebula-api/v1/projects/${id}/restore?path=plain.md&version=${encodeURIComponent(file.version)}`, { method: 'POST' })

    expect(response.status).toBe(412)
    expect(await store.list().then((entries) => entries.some((entry) => entry.path === 'plain.md'))).toBe(false)
  })

  it('restores a file deleted by hand on its own, and a second restore of it is refused', async () => {
    const { store } = await open()
    await store.write('once.md', 'once')
    await store.remove('once.md')
    const [file] = (await store.deletedFiles()).files
    await store.restore(file.path, file.version, { ifAbsent: true })

    await expect(store.restore(file.path, file.version, { ifAbsent: true })).rejects.toBeInstanceOf(FileChangedError)
  })
})

describe('deleted files: only where the server keeps versions', () => {
  it('says so in the place, and is not offered by a server that keeps none', async () => {
    const place = (await (await fetch(`${base}/nebula-api/v1/place`)).json()) as { capabilities: Record<string, boolean> }
    const memoryPlace = (await (await fetch(`${memoryBase}/nebula-api/v1/place`)).json()) as { capabilities: Record<string, boolean> }

    expect(place.capabilities.versions).toBe(true)
    expect(place.capabilities.deletedFiles).toBe(true)
    expect(memoryPlace.capabilities.deletedFiles).toBe(false)
  })

  it('is not offered over folders, which keep no versions: the place says no and the route answers 405', async () => {
    const place = (await (await fetch(`${foldersBase}/nebula-api/v1/place`)).json()) as { capabilities: Record<string, boolean> }
    const made = await fetch(`${foldersBase}/nebula-api/v1/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Plain' }) })
    const { project } = (await made.json()) as { project: { id: string } }

    const response = await fetch(`${foldersBase}/nebula-api/v1/projects/${project.id}/deleted`)

    expect(place.capabilities.deletedFiles).toBe(false)
    expect(response.status).toBe(405)
    expect((await response.json()).error).toBe('not-supported')
  })

  it('answers 405 not-supported on a server that keeps none', async () => {
    const project = await memory.createProject({ name: 'plain' })
    const store = await HttpFileStore.open({ base: memoryBase, projectId: project.id, label: 'test-server', graceMs: 50 })

    const failure = await store.deletedFiles().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ServerError)
    expect((failure as ServerError).status).toBe(405)
    expect((failure as ServerError).code).toBe('not-supported')
  })

  it('is a call the history store carries, so the app can ask for it', async () => {
    const { store } = await open()
    expect(hasDeletedFiles(store)).toBe(true)
  })
})
