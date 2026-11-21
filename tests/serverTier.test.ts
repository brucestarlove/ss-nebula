// @vitest-environment node
// The server tier end to end in Node: HttpFileStore (src/files/serverStore.ts) against the real
// file API (cli/nebula-files.mjs) over HTTP, on folders in a temporary directory. The store passes
// the FileStore conformance every tier passes; the server refuses what it must.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API, createFilesApi, isHiddenName, pathProblem } from '../cli/nebula-files.mjs'
import { createMemoryBackend } from '../cli/backends/memory.mjs'
import { createDatabaseBackend } from '../cli/backends/database.mjs'
import { HttpFileStore, fetchServerInfo } from '../src/files/serverStore'
import { MemoryFileStore } from '../src/files/memoryStore'
import { createBrowserRegistry } from '../src/files/registry'
import { SERVER_OPENED_KEY, connectServer, withServerProjects } from '../src/files/serverRegistry'
import { NESTED_DOT_CASE, registerFileStoreConformance, registerFileStoreTwinConformance } from '../src/files/storeConformance'
import { isValidPath } from '../src/files/paths'
import { isSkippedInFolder } from '../src/files/folderTier'
import type { FileChange } from '../src/files/types'
import { unreachableMessage } from '../src/workspace/views/shared/fileSessions'

let dir = ''
let projectsDir = ''
let base = ''
let port = 0
let api: { handle: (req: unknown, res: unknown) => Promise<boolean>; close: () => void }
let server: ReturnType<typeof createServer>
let made = 0
// The same API over the memory backend: the conformance cases run on both.
let memoryBackend: ReturnType<typeof createMemoryBackend>
let memoryApi: { handle: (req: unknown, res: unknown) => Promise<boolean>; close: () => void }
let memoryServer: ReturnType<typeof createServer>
let memoryBase = ''
let memoryMade = 0
// And over the database backend, on a scratch folder: SQLite for the tree and log, a folder byte store.
let databaseBackend: ReturnType<typeof createDatabaseBackend>
let databaseApi: { handle: (req: unknown, res: unknown) => Promise<boolean>; close: () => void }
let databaseServer: ReturnType<typeof createServer>
let databaseBase = ''
let databaseMade = 0

function serve(files: { handle: (req: unknown, res: unknown) => Promise<boolean> }) {
  return createServer((req, res) => {
    void files.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404)
        res.end()
      }
    })
  })
}

beforeAll(async () => {
  dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'nebula-server-tier-'))
  projectsDir = join(dir, 'projects')
  mkdirSync(projectsDir)
  api = createFilesApi({ projectsDirs: [projectsDir], label: 'test-server' })
  server = serve(api)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
  base = `http://127.0.0.1:${port}`
  memoryBackend = createMemoryBackend()
  memoryApi = createFilesApi({ backend: memoryBackend, label: 'test-server' })
  memoryServer = serve(memoryApi)
  await new Promise<void>((resolve) => memoryServer.listen(0, '127.0.0.1', resolve))
  memoryBase = `http://127.0.0.1:${(memoryServer.address() as { port: number }).port}`
  databaseBackend = createDatabaseBackend({ folder: join(dir, 'database') })
  databaseApi = createFilesApi({ backend: databaseBackend, label: 'test-server' })
  databaseServer = serve(databaseApi)
  await new Promise<void>((resolve) => databaseServer.listen(0, '127.0.0.1', resolve))
  databaseBase = `http://127.0.0.1:${(databaseServer.address() as { port: number }).port}`
})

afterAll(async () => {
  api.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  memoryApi.close()
  memoryServer.closeAllConnections()
  await new Promise((resolve) => memoryServer.close(resolve))
  databaseApi.close()
  databaseServer.closeAllConnections()
  await new Promise((resolve) => databaseServer.close(resolve))
  rmSync(dir, { recursive: true, force: true })
})

/** A new project folder on the server, and its id. */
async function newProject(): Promise<{ id: string; folder: string }> {
  const folder = join(projectsDir, `p${(made += 1)}`)
  mkdirSync(folder)
  const info = await fetchServerInfo({ base })
  const project = info?.projects.find((p) => p.folder === `p${made}`)
  if (!project) throw new Error('the server did not list the new project')
  return { id: project.id, folder }
}

async function openStore(id: string) {
  return HttpFileStore.open({ base, projectId: id, label: 'test-server', graceMs: 50 })
}

/** Each backend the API serves, and a new project on it. The cases about the disk and about other
 * writers below are the folder backend's alone. */
const backends: { label: string; base: () => string; project: () => Promise<string> }[] = [
  { label: 'HttpFileStore', base: () => base, project: async () => (await newProject()).id },
  { label: 'HttpFileStore on the memory backend', base: () => memoryBase, project: async () => (await memoryBackend.createProject({ name: `m${(memoryMade += 1)}` })).id },
  { label: 'HttpFileStore on the database backend', base: () => databaseBase, project: async () => (await databaseBackend.createProject({ name: `d${(databaseMade += 1)}` })).id },
]

for (const backend of backends) {
  const open = (id: string) => HttpFileStore.open({ base: backend.base(), projectId: id, label: 'test-server', graceMs: 50 })
  registerFileStoreConformance({ describe, it }, backend.label, async () => open(await backend.project()), { skip: [NESTED_DOT_CASE] })
  registerFileStoreTwinConformance({ describe, it }, `${backend.label} and another tab`, async () => {
    const id = await backend.project()
    return [await open(id), await open(id)]
  })
}

function raw(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

describe('the server tier: what it says about itself', () => {
  it('lists each folder as a project with its place, keeping an id written into .nebula/project.json', async () => {
    const { id, folder } = await newProject()
    const meta = JSON.parse(readFileSync(join(folder, '.nebula', 'project.json'), 'utf8'))
    expect(meta.id).toBe(id)
    expect(meta.name).toBe(folder.split('/').at(-1))
    const info = await fetchServerInfo({ base })
    expect(info?.place).toEqual({ tier: 'server', label: 'test-server', url: `http://127.0.0.1:${port}` })
    // The same id on the next look.
    expect((await fetchServerInfo({ base }))?.projects.find((p) => p.id === id)).toBeTruthy()
  })

  it('keeps an existing project.json, and serves hidden folders as nothing', async () => {
    const folder = join(projectsDir, 'Kept')
    mkdirSync(join(folder, '.nebula'), { recursive: true })
    writeFileSync(join(folder, '.nebula', 'project.json'), JSON.stringify({ id: 'kept123456', name: 'Kept name', color: '#4ADE80', created: '2026-11-14T00:00:00.000Z', createdBy: 'aeva' }))
    mkdirSync(join(projectsDir, '.hidden'))
    const info = await fetchServerInfo({ base })
    expect(info?.projects.find((p) => p.id === 'kept123456')).toMatchObject({ name: 'Kept name', color: '#4ade80', folder: 'Kept' })
    expect(info?.projects.some((p) => p.folder === '.hidden')).toBe(false)
  })

  it("keeps Nebula's path rules and the folder tier's hidden names", () => {
    for (const path of ['a.md', 'a/b.md', '', '/a', 'a//b', './a', 'a/..', 'a\\b', 'a\u0000b', 'x'.repeat(256), 'é'.repeat(128), 'Plans: phase 1?.md', 'trailing ']) {
      expect(pathProblem(path) === null, JSON.stringify(path)).toBe(isValidPath(path))
    }
    for (const name of ['.git', '.env', 'node_modules', 'Thumbs.db', 'DESKTOP.INI', 'a.crswap', 'notes.md', 'node_modules2']) {
      expect(isHiddenName(name), name).toBe(isSkippedInFolder(name))
    }
  })
})

describe('the server tier: what it refuses', () => {
  it('answers only the names it serves, and never another site', async () => {
    const { id } = await newProject()
    const list = `${API}/projects/${id}/list`
    expect((await raw('GET', list)).status).toBe(200)
    expect((await raw('GET', list, { host: 'rebind.example' })).status).toBe(421)
    expect((await raw('GET', list, { host: `localhost:${port}` })).status).toBe(200)
    expect((await raw('GET', list, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await raw('GET', list, { 'sec-fetch-site': 'same-site' })).status).toBe(403)
    expect((await raw('GET', list, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await raw('GET', list, { origin: 'null' })).status).toBe(403)
    expect((await raw('GET', list, { 'sec-fetch-site': 'same-origin', origin: `http://127.0.0.1:${port}` })).status).toBe(200)
    // A write from another site changes nothing, even one a form could send without asking.
    const put = await raw('PUT', `${API}/projects/${id}/file?path=evil.md`, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, 'x')
    expect(put.status).toBe(403)
    expect((await raw('PUT', `${API}/projects/${id}/file?path=evil.md`, { 'sec-fetch-site': 'none' }, 'x')).status).toBe(403)
    const store = await openStore(id)
    expect(await store.list()).toEqual([])
    // No CORS, on any answer.
    for (const res of [await raw('GET', list), put]) {
      expect(Object.keys(res.headers).filter((h) => h.startsWith('access-control-'))).toEqual([])
    }
    // The events too.
    expect((await raw('GET', `${API}/projects/${id}/events`, { origin: 'https://evil.example' })).status).toBe(403)
  })

  it('never leaves the project: .., encoded .., absolute paths, symlinks, hidden names', async () => {
    const { id, folder } = await newProject()
    const outside = join(dir, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'TOP-SECRET-BYTES')
    symlinkSync(outside, join(folder, 'link'))
    symlinkSync(join(outside, 'secret.txt'), join(folder, 'secret-link.txt'))
    mkdirSync(join(folder, '.git'))
    writeFileSync(join(folder, '.git', 'config'), 'TOKEN-BYTES')
    writeFileSync(join(folder, '.env'), 'KEY=x')
    const file = (path: string) => `${API}/projects/${id}/file?path=${encodeURIComponent(path)}`
    for (const path of ['../outside/secret.txt', '..%2Foutside%2Fsecret.txt', '/etc/passwd', 'link/secret.txt', 'secret-link.txt', '.git/config', '.env', 'a/../../outside/secret.txt']) {
      const res = await raw('GET', file(path))
      expect(res.status, path).toBeGreaterThanOrEqual(400)
      expect(res.text, path).not.toContain('TOP-SECRET-BYTES')
      expect(res.text, path).not.toContain('TOKEN-BYTES')
    }
    for (const path of ['link/new.md', 'secret-link.txt', '.git/hooks/pre-commit', '../outside/new.md']) {
      expect((await raw('PUT', file(path), {}, 'x')).status, path).toBeGreaterThanOrEqual(400)
    }
    expect((await raw('DELETE', file('link'))).status).toBe(403)
    expect((await raw('POST', `${API}/projects/${id}/rename?from=link&to=moved`)).status).toBe(403)
    expect((await raw('POST', `${API}/projects/${id}/rename?from=a.md&to=${encodeURIComponent('../escaped.md')}`)).status).toBe(400)
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('TOP-SECRET-BYTES')
    expect(existsSync(join(outside, 'new.md'))).toBe(false)
    expect(existsSync(join(dir, 'escaped.md'))).toBe(false)
    // The listing shows none of them.
    const store = await openStore(id)
    expect((await store.list()).map((e) => e.path)).toEqual([])
    // A project id that isn't one, or a route that isn't one.
    expect((await raw('GET', `${API}/projects/..%2F..%2Fetc/list`)).status).toBe(404)
    expect((await raw('GET', `${API}/nope`)).status).toBe(404)
  })

  it("serves a file's bytes as a download, never as a page", async () => {
    const { id } = await newProject()
    const store = await openStore(id)
    await store.write('page.html', '<script>alert(1)</script>')
    const res = await raw('GET', `${API}/projects/${id}/file?path=page.html`)
    expect(res.headers['content-type']).toBe('application/octet-stream')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(String(res.headers['content-security-policy'])).toContain('sandbox')
  })
})

describe('the server tier: changes made outside Nebula', () => {
  it("hears an agent's write, a new folder and a removal within a second, and its own writes once", async () => {
    const { id, folder } = await newProject()
    const store = await openStore(id)
    const changes: FileChange[] = []
    const stop = store.watch((change) => changes.push(change))
    try {
      await new Promise((resolve) => setTimeout(resolve, 150))
      const started = Date.now()
      writeFileSync(join(folder, 'agent.md'), '# From an agent\n')
      while (!changes.some((c) => c.type === 'write' && c.path === 'agent.md') && Date.now() - started < 1_000) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(changes).toContainEqual({ type: 'write', path: 'agent.md' })
      expect(Date.now() - started).toBeLessThan(1_000)
      mkdirSync(join(folder, 'Briefs'))
      rmSync(join(folder, 'agent.md'))
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(changes).toContainEqual({ type: 'mkdir', path: 'Briefs' })
      expect(changes).toContainEqual({ type: 'remove', path: 'agent.md' })
      // Nebula's own write: told once, when it lands, and not again from the folder.
      const before = changes.length
      await store.write('Briefs/mine.md', 'mine')
      await store.rename('Briefs/mine.md', 'Briefs/ours.md')
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(changes.slice(before)).toEqual([
        { type: 'write', path: 'Briefs/mine.md' },
        { type: 'rename', from: 'Briefs/mine.md', to: 'Briefs/ours.md' },
      ])
    } finally {
      stop()
    }
  })

  it('says the server went out of reach and came back, and resumes from where it was', async () => {
    const { id, folder } = await newProject()
    const store = await openStore(id)
    const changes: FileChange[] = []
    const stop = store.watch((change) => changes.push(change))
    try {
      await new Promise((resolve) => setTimeout(resolve, 150))
      const heard = async (path: string) => {
        const started = Date.now()
        while (!changes.some((c) => c.type === 'write' && c.path === path) && Date.now() - started < 4_000) await new Promise((resolve) => setTimeout(resolve, 20))
      }
      writeFileSync(join(folder, 'before.md'), 'x')
      await heard('before.md')
      // Drop every connection: the feed reconnects from its cursor, after a pause longer than
      // the grace (50 ms here), so watchers hear it went and came back.
      server.closeAllConnections()
      writeFileSync(join(folder, 'while-away.md'), 'x')
      await heard('while-away.md')
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(changes).toEqual([
        { type: 'write', path: 'before.md' },
        { type: 'unreachable', folder: 'test-server' },
        { type: 'reachable' },
        { type: 'write', path: 'while-away.md' },
      ])
    } finally {
      stop()
    }
  })
})

/** localStorage, in memory. */
function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  }
}

describe("the server tier's projects beside the browser's", () => {
  it('lists both, opens a server project as its folder, and starts where it was last', async () => {
    const { id } = await newProject()
    const inner = createBrowserRegistry(new MemoryFileStore())
    const mine = await inner.create({ name: 'Mine', color: '#7c8cff' })
    await inner.open(mine.id)
    const info = await fetchServerInfo({ base })
    const storage = memoryStorage()
    const registry = withServerProjects(inner, connectServer(info!, { base, graceMs: 50 }), storage)
    await new Promise((resolve) => setTimeout(resolve, 5))

    const listed = await registry.list()
    expect(listed.map((r) => r.id)).toContain(mine.id)
    const record = listed.find((r) => r.id === id)
    expect(record).toMatchObject({ tier: 'server', server: { label: 'test-server', folder: `p${made}` } })
    expect(await registry.current()).toBe(mine.id)

    const store = await registry.open(id)
    await store.write('Briefs/x.md', '# X')
    expect(readFileSync(join(projectsDir, `p${made}`, 'Briefs', 'x.md'), 'utf8')).toBe('# X')
    // One store, so one change feed, per project.
    expect(await registry.files(id)).toBe(store)
    expect(await registry.current()).toBe(id)
    expect(JSON.parse(storage.getItem(SERVER_OPENED_KEY) ?? '{}')[id]).toBeTruthy()
    expect((await registry.list())[0].id).toBe(id)

    // Opening the browser's project again makes it the one to start with.
    await new Promise((resolve) => setTimeout(resolve, 5))
    await registry.open(mine.id)
    expect(await registry.current()).toBe(mine.id)
  })

  it("renames and recolours a server project in its project.json, and won't remove it", async () => {
    const { id, folder } = await newProject()
    const registry = withServerProjects(createBrowserRegistry(new MemoryFileStore()), connectServer((await fetchServerInfo({ base }))!, { base }), memoryStorage())
    await registry.list()
    const renamed = await registry.update(id, { name: 'Artifacts', color: '#2DD4BF' })
    expect(renamed).toMatchObject({ id, name: 'Artifacts', color: '#2dd4bf', tier: 'server' })
    const meta = JSON.parse(readFileSync(join(folder, '.nebula', 'project.json'), 'utf8'))
    expect(meta).toMatchObject({ id, name: 'Artifacts', color: '#2dd4bf' })
    await expect(registry.remove(id)).rejects.toMatchObject({ name: 'ServerProjectError' })
    expect(existsSync(folder)).toBe(true)
  })
})

describe('nebula run with folders', () => {
  it('serves the app and the folders, marked so the app finds them, and refuses a missing folder', async () => {
    const { startNebulaStaticServer } = await import('../cli/nebula-cli.mjs')
    const staticRoot = join(dir, 'app')
    mkdirSync(staticRoot, { recursive: true })
    writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>Nebula</title>')
    const vault = join(dir, 'Vault')
    mkdirSync(vault)
    writeFileSync(join(vault, 'Note.md'), '# Note')
    const run = await startNebulaStaticServer({ host: '127.0.0.1', port: 0, root: staticRoot, silent: true, projects: [vault], label: 'pro' })
    try {
      const page = await fetch(run.url)
      expect(page.headers.get('server-timing')).toBe('nebula-files;desc="/nebula-api/v1"')
      const info = await fetchServerInfo({ base: run.url.replace(/\/$/, '') })
      expect(info?.place.label).toBe('pro')
      expect(info?.projects.map((p) => p.name)).toEqual(['Vault'])
      const store = await HttpFileStore.open({ base: run.url.replace(/\/$/, ''), projectId: info!.projects[0].id, label: 'pro' })
      expect(await store.readText('Note.md')).toBe('# Note')
    } finally {
      run.server.closeAllConnections()
      await new Promise((resolve) => run.server.close(resolve))
    }
    // Without folders, no mark and no API.
    const plain = await startNebulaStaticServer({ host: '127.0.0.1', port: 0, root: staticRoot, silent: true })
    try {
      expect((await fetch(plain.url)).headers.get('server-timing')).toBeNull()
      expect(await fetchServerInfo({ base: plain.url.replace(/\/$/, '') })).toBeNull()
    } finally {
      await new Promise((resolve) => plain.server.close(resolve))
    }
    await expect(startNebulaStaticServer({ host: '127.0.0.1', port: 0, root: staticRoot, silent: true, projects: [join(dir, 'missing')] })).rejects.toThrow(/Not a folder/)
  })
})

describe('what a view says while the server is out of reach', () => {
  it('names the server as a place, and a folder as a folder', async () => {
    await openStore((await newProject()).id)
    expect(unreachableMessage('test-server')).toBe('Nebula can’t reach ‘test-server’ right now. Your changes are kept here and saved when it’s back.')
    expect(unreachableMessage('Vault')).toBe('Nebula can’t reach the folder ‘Vault’ right now. Your changes are kept here and saved when it’s back.')
  })
})

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("Secu's round 1 (reports/secu-server-1.md)", () => {
  it('S2: hears an agent remove or move what the app saved a moment ago', async () => {
    const { id, folder } = await newProject()
    const store = await openStore(id)
    const changes: FileChange[] = []
    const stop = store.watch((change) => changes.push(change))
    try {
      await pause(150)
      await store.write('m.md', 'saved')
      await store.write('n.md', 'saved')
      await store.write('Docs/d.md', 'saved')
      rmSync(join(folder, 'm.md'))
      renameSync(join(folder, 'n.md'), join(folder, 'n-renamed.md'))
      rmSync(join(folder, 'Docs'), { recursive: true })
      await pause(500)
      expect(changes).toContainEqual({ type: 'remove', path: 'm.md' })
      expect(changes).toContainEqual({ type: 'remove', path: 'n.md' })
      expect(changes).toContainEqual({ type: 'write', path: 'n-renamed.md' })
      expect(changes).toContainEqual({ type: 'remove', path: 'Docs' })
    } finally {
      stop()
    }
  })

  it('S3: a project whose folder was renamed on the server keeps its feed, from a fresh start', async () => {
    const { id, folder } = await newProject()
    const store = await openStore(id)
    const changes: FileChange[] = []
    const stop = store.watch((change) => changes.push(change))
    try {
      await pause(150)
      const moved = `${folder}-moved`
      renameSync(folder, moved)
      expect((await fetchServerInfo({ base }))?.projects.find((p) => p.id === id)?.folder).toBe(`p${made}-moved`)
      await pause(1_500)
      writeFileSync(join(moved, 'after.md'), 'x')
      const started = Date.now()
      while (!changes.some((c) => c.type === 'write' && c.path === 'after.md') && Date.now() - started < 4_000) await pause(20)
      expect(changes).toContainEqual({ type: 'write', path: 'after.md' })
    } finally {
      stop()
    }
  })

  it('S5: a .nebula that is a symlink is never written through', async () => {
    const { id, folder } = await newProject()
    const outside = join(dir, 'outside-nebula')
    mkdirSync(outside, { recursive: true })
    rmSync(join(folder, '.nebula'), { recursive: true })
    symlinkSync(outside, join(folder, '.nebula'))
    const res = await raw('PUT', `${API}/projects/${id}/file?path=a.md`, {}, 'x')
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(readdirSync(outside)).toEqual([])
    expect(existsSync(join(folder, 'a.md'))).toBe(false)
  })

  it(".nebula can't be renamed or moved into, and project.json keeps the project's id (S8, S11)", async () => {
    const { id, folder } = await newProject()
    const store = await openStore(id)
    await store.write('F/a.md', 'a')
    expect((await raw('POST', `${API}/projects/${id}/rename?from=.nebula&to=elsewhere`)).status).toBe(403)
    expect((await raw('POST', `${API}/projects/${id}/rename?from=F&to=.nebula%2FF`)).status).toBe(403)
    expect((await raw('POST', `${API}/projects/${id}/rename?from=.nebula%2Fproject.json&to=p.json`)).status).toBe(403)
    const meta = JSON.parse(readFileSync(join(folder, '.nebula', 'project.json'), 'utf8'))
    const other = JSON.stringify({ ...meta, id: 'someoneelse' })
    expect((await raw('PUT', `${API}/projects/${id}/file?path=.nebula%2Fproject.json`, {}, other)).status).toBe(400)
    expect((await raw('PUT', `${API}/projects/${id}/file?path=.nebula%2Fproject.json`, {}, 'not json')).status).toBe(400)
    expect((await raw('PUT', `${API}/projects/${id}/file?path=.nebula%2Fproject.json`, {}, ' '.repeat(1_100_000))).status).toBe(413)
    expect((await raw('PUT', `${API}/projects/${id}/file?path=.nebula%2Fproject.json`, {}, JSON.stringify({ ...meta, name: 'Renamed' }))).status).toBe(200)
    expect((await fetchServerInfo({ base }))?.projects.find((p) => p.id === id)?.name).toBe('Renamed')
  })

  it("S9, S10: a Host that only starts like loopback, an id that is not one, and the feed's headers", async () => {
    const { id } = await newProject()
    expect((await raw('GET', `${API}/projects/${id}/list`, { host: '[::1].evil.com' })).status).not.toBe(200)
    expect((await raw('GET', `${API}/projects/%E0%A4%A/list`)).status).toBe(404)
    const headers = await new Promise<Record<string, string | string[] | undefined>>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: `${API}/projects/${id}/events` }, (res) => {
        resolve(res.headers)
        res.destroy()
      })
      req.on('error', reject)
      req.end()
    })
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(String(headers['content-security-policy'])).toContain('sandbox')
  })

  it("S1, S6: nebula run can't be framed, and won't serve folders beyond loopback without --allow-host", async () => {
    const { startNebulaStaticServer } = await import('../cli/nebula-cli.mjs')
    const staticRoot = join(dir, 'app-s1')
    mkdirSync(staticRoot, { recursive: true })
    writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>Nebula</title>')
    const vault = join(dir, 'Vault-s1')
    mkdirSync(vault, { recursive: true })
    const run = await startNebulaStaticServer({ host: '127.0.0.1', port: 0, root: staticRoot, silent: true, projects: [vault] })
    try {
      const page = await fetch(run.url)
      expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
      expect(page.headers.get('x-frame-options')).toBe('DENY')
    } finally {
      run.server.closeAllConnections()
      await new Promise((resolve) => run.server.close(resolve))
    }
    await expect(startNebulaStaticServer({ host: '0.0.0.0', port: 0, root: staticRoot, silent: true, projects: [vault] })).rejects.toThrow(/--allow-host/)
  })
})
