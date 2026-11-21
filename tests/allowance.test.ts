// @vitest-environment node
// The host's allowance and signing in (cli/nebula-files.mjs): what a write adds less what it
// replaces, a declared length refused before a byte is read, the links a host may give the app, and
// `signedOut()`. The Suite's workspaces rely on all of it. The API runs over the memory backend (and,
// where history matters, the database backend), asked as a web-standard `fetch`; the cases about
// streams and connections go through a real server on 127.0.0.1.
import { afterEach, describe, expect, it } from 'vitest'
import { Agent, createServer, request as httpRequest } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { API, createFilesApi as makeFilesApi, signedOut } from '../cli/nebula-files.mjs'
import { createNebulaApp } from '../cli/app.mjs'
import { createDatabaseBackend } from '../cli/backends/database.mjs'
import { createMemoryBackend } from '../cli/backends/memory.mjs'
import { BackendError } from '../cli/backend.mjs'
import { ADA, cleanScratch, scratch } from './databaseSupport'

/** createFilesApi, whose JSDoc types its options from their defaults. */
const createFilesApi = makeFilesApi as (options: Record<string, unknown>) => ReturnType<typeof makeFilesApi>
type Api = ReturnType<typeof makeFilesApi>
type Allowance = number | ((request: Request, actor: unknown) => unknown)

const apis: Api[] = []
const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => {
  while (apis.length) apis.pop()?.close()
  while (servers.length) {
    const server = servers.pop() as ReturnType<typeof createServer>
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  cleanScratch()
})

const BASE = 'http://localhost'

async function memory(allowance?: Allowance, options: Record<string, unknown> = {}) {
  const backend = (options.backend as ReturnType<typeof createMemoryBackend> | undefined) ?? createMemoryBackend()
  const logged: string[] = []
  const api = createFilesApi({ backend, label: 'allowance', allowance, log: (line: string) => logged.push(line), ...options })
  apis.push(api)
  const { id } = await (backend.createProject as NonNullable<typeof backend.createProject>)({ name: 'Space' }, { actor: ADA })
  return { api, backend, id, logged }
}

/** A workspace whose limit the case moves: `state.limit` is what the allowance answers (a number, an object, undefined…). */
async function space(initial: unknown = 1_000_000, options: Record<string, unknown> = {}) {
  const state = { limit: initial }
  const made = await memory(() => state.limit, options)
  return { ...made, state }
}

const call = (api: Api, method: string, path: string, init: { headers?: Record<string, string>; body?: string | Uint8Array } = {}) =>
  api.fetch(new Request(`${BASE}${API}${path}`, { method, headers: init.headers, body: init.body as BodyInit | undefined }), {}) as Promise<Response>
const put = (api: Api, id: string, path: string, size: number | string, headers: Record<string, string> = {}) =>
  call(api, 'PUT', `/projects/${id}/file?path=${encodeURIComponent(path)}`, { headers, body: typeof size === 'number' ? 'x'.repeat(size) : size })
const json = async (response: Response) => (await response.json()) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const place = async (api: Api) => json(await call(api, 'GET', '/place'))

describe('the allowance gates a write by what it adds less what it replaces', () => {
  it('lets a file fit up to the limit exactly, and refuses one byte more with space-full, numbers and an upgrade link, storing nothing', async () => {
    const { api, backend, id, state } = await space()
    const base = (await backend.usage()).bytes
    expect(base).toBeGreaterThan(0)
    state.limit = { bytes: base + 1500, upgrade: 'https://example.test/more-space' }
    expect((await put(api, id, 'a.md', 1000)).status).toBe(200)
    const refused = await put(api, id, 'b.md', 501)
    expect(refused.status).toBe(507)
    expect(await json(refused)).toMatchObject({ error: 'space-full', used: base + 1000, limit: base + 1500, upgrade: 'https://example.test/more-space' })
    expect(await backend.stat(id, 'b.md')).toBeNull()
    expect((await backend.usage()).bytes).toBe(base + 1000)
    // Exactly what is left fits; one byte more doesn't.
    expect((await put(api, id, 'b.md', 500)).status).toBe(200)
    expect((await backend.usage()).bytes).toBe(base + 1500)
    const full = await put(api, id, 'c.md', 1)
    expect(full.status).toBe(507)
    const body = await json(full)
    expect(body).toMatchObject({ error: 'space-full', used: base + 1500, limit: base + 1500 })
    expect(typeof body.used).toBe('number')
    expect(typeof body.limit).toBe('number')
    expect(typeof body.upgrade).toBe('string')
    expect(await backend.stat(id, 'c.md')).toBeNull()
  })

  it('counts what a write replaces: a larger file in place of another fits when the difference does', async () => {
    const { api, backend, id, state } = await space()
    const base = (await backend.usage()).bytes
    state.limit = base + 1000
    expect((await put(api, id, 'a.md', 900)).status).toBe(200)
    // 900 used of 1,000: a 1,000-byte file in place of the 900 adds 100, and fits; 1,001 doesn't.
    expect((await put(api, id, 'a.md', 1001)).status).toBe(507)
    expect((await put(api, id, 'a.md', 1000)).status).toBe(200)
    expect((await backend.usage()).bytes).toBe(base + 1000)
    expect((await backend.stat(id, 'a.md'))?.entry.size).toBe(1000)
  })
})

describe('a write that doesn’t grow usage always passes', () => {
  async function overLimit() {
    const made = await space()
    for (const [path, size] of [['a.md', 400], ['b.md', 300], ['c/d.md', 100]] as const) expect((await put(made.api, made.id, path, size)).status).toBe(200)
    // The limit is lowered below what the files already hold.
    made.state.limit = (await made.backend.usage()).bytes - 200
    return made
  }

  it('answers 200 for a same-size and a smaller replacement, and 507 for one byte larger', async () => {
    const { api, id } = await overLimit()
    // Over by 200: a new byte, or a byte more in a file, is refused; the same size and fewer bytes pass.
    expect((await put(api, id, 'new.md', 1)).status).toBe(507)
    expect((await put(api, id, 'a.md', 401)).status).toBe(507)
    expect((await put(api, id, 'a.md', 400)).status).toBe(200)
    expect((await put(api, id, 'a.md', 399)).status).toBe(200)
    expect((await put(api, id, 'a.md', 1)).status).toBe(200)
    expect((await put(api, id, 'new.md', 0)).status).toBe(200)
  })

  it('answers 200 for a remove, a rename and a new folder while over', async () => {
    const { api, backend, id } = await overLimit()
    expect((await call(api, 'POST', `/projects/${id}/mkdir?path=${encodeURIComponent('folder/inner')}`)).status).toBe(200)
    expect((await call(api, 'POST', `/projects/${id}/rename?from=b.md&to=${encodeURIComponent('folder/b.md')}`)).status).toBe(200)
    expect((await call(api, 'DELETE', `/projects/${id}/file?path=a.md`)).status).toBe(200)
    expect(await backend.stat(id, 'a.md')).toBeNull()
    expect((await backend.stat(id, 'folder/b.md'))?.entry.size).toBe(300)
  })
})

describe('the allowance as a function', () => {
  it('gets the request and the actor, and a number, { bytes, upgrade } or nothing answers', async () => {
    const seen: Array<{ request: unknown; actor: unknown }> = []
    let answer: unknown = 5000
    const { api, backend, id } = await memory((request, actor) => (seen.push({ request, actor }), answer))
    expect((await put(api, id, 'a.md', 10)).status).toBe(200)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0].request).toBeInstanceOf(Request)
    expect(seen[0].actor).toMatchObject({ type: 'human', id: expect.any(String), name: expect.any(String) })
    expect((await place(api)).space).toEqual({ used: (await backend.usage()).bytes, limit: 5000 })
    answer = { bytes: 6000, upgrade: '/plans' }
    expect((await place(api)).space).toEqual({ used: (await backend.usage()).bytes, limit: 6000, upgrade: '/plans' })
    // Nothing answered: no limit. The place says what is used and no limit; no write is refused.
    answer = undefined
    const open = (await place(api)).space
    expect(open).toEqual({ used: (await backend.usage()).bytes })
    expect('limit' in open).toBe(false)
    expect((await put(api, id, 'big.md', 200_000)).status).toBe(200)
  })

  it('answers 500 internal, logged, for a negative or non-numeric answer, and stores nothing', async () => {
    let answer: unknown = -1
    const { api, backend, id, logged } = await memory(() => answer)
    for (const mistake of [-1, 'lots', Number.NaN, { bytes: 'many' }, { bytes: -5 }, Infinity]) {
      answer = mistake
      const before = logged.length
      const response = await put(api, id, 'a.md', 10)
      expect([String(mistake), response.status, (await json(response)).error]).toEqual([String(mistake), 500, 'internal'])
      expect(logged.length).toBeGreaterThan(before)
      expect(await backend.stat(id, 'a.md')).toBeNull()
      expect((await call(api, 'GET', '/place')).status).toBe(500)
    }
    // A sound answer afterwards works again.
    answer = 5000
    expect((await put(api, id, 'a.md', 10)).status).toBe(200)
  })

  it('throws when the API is made with a non-numeric option, and takes 0 and a function', () => {
    for (const bad of ['lots', -1, Number.NaN, Infinity, null, {}, true]) {
      expect(() => createFilesApi({ backend: createMemoryBackend(), allowance: bad }), String(bad)).toThrow()
    }
    for (const fine of [0, 1500, () => 1, undefined]) {
      const api = createFilesApi({ backend: createMemoryBackend(), allowance: fine })
      api.close()
    }
  })
})

describe('GET <api>/place says space only when the option is set', () => {
  it('has no space without it, and used follows writes, overwrites and removes', async () => {
    const plain = await memory(undefined)
    expect('space' in (await place(plain.api))).toBe(false)
    const { api, backend, id } = await memory(1_000_000)
    const used = async () => (await place(api)).space.used as number
    const base = await used()
    expect(base).toBe((await backend.usage()).bytes)
    await put(api, id, 'a.md', 100)
    expect(await used()).toBe(base + 100)
    await put(api, id, 'a.md', 40)
    expect(await used()).toBe(base + 40)
    await call(api, 'DELETE', `/projects/${id}/file?path=a.md`)
    expect(await used()).toBe(base)
    expect((await place(api)).space.limit).toBe(1_000_000)
  })

  it('does not count the earlier versions kept for history: overwrite a file five times and used stays at its current size', async () => {
    const backend = createDatabaseBackend({ folder: join(scratch('space'), 'db') })
    const { api, id } = await memory(1_000_000, { backend })
    const base = (await place(api)).space.used as number
    for (let count = 0; count < 5; count += 1) await put(api, id, 'a.md', `revision ${count} `.repeat(20))
    expect((await place(api)).space.used).toBe(base + `revision 4 `.repeat(20).length)
    expect((await backend.versions(id, 'a.md')).versions).toHaveLength(5)
  })
})

describe('roomFor(request, actor, adding, replacing)', () => {
  const request = () => new Request(`${BASE}${API}/place`)
  const actor = ADA

  it('is Infinity with no limit, and otherwise what is left plus what is replaced, never less than the replaced', async () => {
    const none = await memory(undefined)
    expect(await none.api.roomFor(request(), actor)).toBe(Infinity)
    expect(await none.api.roomFor(request(), actor, 10 ** 12, 5)).toBe(Infinity)
    const open = await memory(() => undefined)
    expect(await open.api.roomFor(request(), actor, 10 ** 12)).toBe(Infinity)
    const { api, backend, id, state } = await space()
    await put(api, id, 'a.md', 300)
    const used = (await backend.usage()).bytes
    state.limit = used + 200
    expect(await api.roomFor(request(), actor, undefined, 0)).toBe(200)
    expect(await api.roomFor(request(), actor, undefined, 50)).toBe(250)
    // Over the limit: never less than the file replaced.
    state.limit = used - 100
    expect(await api.roomFor(request(), actor, undefined, 0)).toBe(0)
    expect(await api.roomFor(request(), actor, undefined, 40)).toBe(40)
    expect(await api.roomFor(request(), actor, 40, 40)).toBe(40)
  })

  it('throws space-full when adding is larger than the room, and not when it is exactly the room', async () => {
    const { api, backend, id, state } = await space()
    await put(api, id, 'a.md', 300)
    const limit = (await backend.usage()).bytes + 200
    state.limit = limit
    expect(await api.roomFor(request(), actor, 200, 0)).toBe(200)
    await expect(api.roomFor(request(), actor, 201, 0)).rejects.toMatchObject({ code: 'space-full', status: 507, extra: { limit } })
    await expect(api.roomFor(request(), actor, 251, 50)).rejects.toMatchObject({ code: 'space-full' })
    expect(await api.roomFor(request(), actor, 250, 50)).toBe(250)
  })

  it('refuses a restore only when it grows past the limit: the old version’s size is adding, the current file’s is replacing', async () => {
    const backend = createDatabaseBackend({ folder: join(scratch('restore'), 'db') })
    const { api, id, state } = await space(1_000_000, { backend })
    await put(api, id, 'n.md', 400)
    await put(api, id, 'n.md', 100)
    const [current, old] = (await backend.versions(id, 'n.md')).versions
    const path = `/projects/${id}/restore?path=n.md&version=${encodeURIComponent(old.version)}`
    const etag = `"${current.version}"`
    const used = (await backend.usage()).bytes
    // Restoring the 400 bytes over the 100 grows usage by 300.
    state.limit = used + 299
    const refused = await call(api, 'POST', path, { headers: { 'if-match': etag } })
    expect([refused.status, (await json(refused)).error]).toEqual([507, 'space-full'])
    expect((await backend.stat(id, 'n.md'))?.entry.size).toBe(100)
    state.limit = used + 300
    expect((await call(api, 'POST', path, { headers: { 'if-match': etag } })).status).toBe(200)
    expect((await backend.stat(id, 'n.md'))?.entry.size).toBe(400)
    // Restoring the smaller one over the larger shrinks usage, so it passes even when the workspace is over.
    state.limit = 10
    const shrink = (await backend.versions(id, 'n.md')).versions.find((version: { size: number; current: boolean }) => version.size === 100 && !version.current)
    const back = await call(api, 'POST', `/projects/${id}/restore?path=n.md&version=${encodeURIComponent(shrink.version)}`, { headers: { 'if-match': `"${(await backend.stat(id, 'n.md'))?.version}"` } })
    expect(back.status).toBe(200)
  })
})

describe('space-full and disk-full stay apart', () => {
  it('both are 507, the codes differ, and a full byte store answers disk-full through an API that has an allowance', async () => {
    const dir = scratch('full')
    let full = false
    const inner = (await import('../cli/bytes/folder.mjs')).createFolderByteStore({ root: join(dir, 'bytes') })
    const bytes = Object.assign(Object.create(inner), {
      put: (...args: unknown[]) => {
        if (full) throw new BackendError('disk-full', 'The disk is full, so that couldn’t be saved')
        return (inner.put as (...a: unknown[]) => unknown)(...args)
      },
    })
    const backend = createDatabaseBackend({ file: join(dir, 'nebula.db'), bytes })
    const { api, id, state } = await space(100_000, { backend })
    expect((await put(api, id, 'a.md', 10)).status).toBe(200)
    state.limit = 5
    const noRoom = await put(api, id, 'b.md', 100)
    state.limit = 100_000
    full = true
    const disk = await put(api, id, 'b.md', 100)
    expect([noRoom.status, disk.status]).toEqual([507, 507])
    const diskBody = await json(disk)
    expect([(await json(noRoom)).error, diskBody.error]).toEqual(['space-full', 'disk-full'])
    expect('limit' in diskBody || 'used' in diskBody).toBe(false)
  })
})

describe('the links a host gives the app', () => {
  const bad = ['javascript:alert(1)', '//elsewhere.example', `https://example.test/${'a'.repeat(3000)}`, 'ftp://example.test', 'data:text/html,x', 'sign-in', 'https://exa mple.test', '/ spaced', '', 'https:', 'file:///etc/passwd', 'JAVASCRIPT:alert(1)', ' https://example.test']
  const good = ['https://example.test/sign-in', 'http://localhost:3000/in?next=%2Fapp#top', '/sign-in', '/plans?x=1&y=2']

  it('signedOut takes an http(s) address or a path on the host as signIn, and throws for anything else', async () => {
    for (const link of good) {
      const response = signedOut({ signIn: link })
      expect([link, (await response.json()).signIn]).toEqual([link, link])
    }
    for (const link of bad) expect(() => signedOut({ signIn: link }), JSON.stringify(link).slice(0, 60)).toThrow()
  })

  it('an allowance’s upgrade takes the same, and anything else is the host’s mistake: 500, and nothing is sent to the app', async () => {
    let upgrade = ''
    const { api, backend, id, logged } = await memory(() => ({ bytes: 1, upgrade }))
    for (const link of good) {
      upgrade = link
      expect((await place(api)).space.upgrade).toBe(link)
      const refused = await put(api, id, 'a.md', 100)
      expect([refused.status, (await json(refused)).upgrade]).toEqual([507, link])
    }
    for (const link of bad) {
      upgrade = link
      const before = logged.length
      for (const response of [await call(api, 'GET', '/place'), await put(api, id, 'a.md', 100)]) {
        const text = await response.text()
        expect([JSON.stringify(link).slice(0, 40), response.status]).toEqual([JSON.stringify(link).slice(0, 40), 500])
        expect(text).not.toContain('javascript')
        expect(text).not.toContain('elsewhere')
        expect(JSON.parse(text).error).toBe('internal')
      }
      expect(logged.length).toBeGreaterThan(before)
    }
    expect(await backend.stat(id, 'a.md')).toBeNull()
  })
})

describe('signedOut', () => {
  it('is a 401 of JSON, never cached, with error, a message and the sign-in address', async () => {
    const response = signedOut({ signIn: '/sign-in', message: 'Your session ended.' })
    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toMatch(/^application\/json/)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ error: 'signed-out', message: 'Your session ended.', signIn: '/sign-in' })
    const bare = await signedOut().json()
    expect(Object.keys(bare).sort()).toEqual(['error', 'message'])
    expect(bare.error).toBe('signed-out')
    expect(bare.message.length).toBeGreaterThan(0)
    // The message is one line of at most 300 characters; an empty one has a default.
    const long = await signedOut({ message: `first line\nsecond\t line ${'x'.repeat(500)}` }).json()
    expect(long.message.length).toBeLessThanOrEqual(300)
    expect(long.message).not.toMatch(/[\n\r\t]/)
    expect((await signedOut({ message: '   ' }).json()).message).toBe(bare.message)
  })

  // Was a bug (found by this test), fixed at integration: `signedOut` sliced the message to 300 characters, but `cleanName` has already cut it to
  // 80, so a host's message of 81 to 300 characters is truncated mid-sentence. The brief and the contract say 300.
  it('keeps a message of up to 300 characters whole', async () => {
    const message = `${'Your session on this account has ended, so please sign in again to carry on. '.repeat(3)}`.trim()
    expect(message.length).toBeGreaterThan(80)
    expect(message.length).toBeLessThanOrEqual(300)
    expect((await signedOut({ message }).json()).message).toBe(message)
  })

  it('returned from resolve, it is the answer for every route including events, and neither the allowance nor the place runs', async () => {
    const backend = createMemoryBackend()
    const { id } = await (backend.createProject as NonNullable<typeof backend.createProject>)({ name: 'Signed out' })
    let asked = 0
    let allowed = 0
    const api = createFilesApi({
      backend,
      label: 'signed-out',
      allowance: () => {
        allowed += 1
        return 100
      },
      resolve: () => {
        asked += 1
        return signedOut({ signIn: 'https://accounts.example.test/in' })
      },
    })
    apis.push(api)
    const routes: [string, string][] = [
      ['GET', '/place'],
      ['GET', `/projects/${id}/events`],
      ['GET', `/projects/${id}/list`],
      ['GET', `/projects/${id}/file?path=a.md`],
      ['PUT', `/projects/${id}/file?path=a.md`],
      ['DELETE', `/projects/${id}/file?path=a.md`],
      ['POST', `/projects/${id}/mkdir?path=d`],
      ['GET', '/changes'],
      ['POST', '/projects'],
      ['GET', '/projects/nobody/state'],
    ]
    for (const [method, path] of routes) {
      const response = await call(api, method, path, method === 'PUT' ? { body: 'x' } : {})
      expect([method, path, response.status]).toEqual([method, path, 401])
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toMatchObject({ error: 'signed-out', signIn: 'https://accounts.example.test/in' })
    }
    expect(asked).toBe(routes.length)
    expect(allowed).toBe(0)
    expect(await backend.stat(id, 'a.md')).toBeNull()
    expect(await backend.stat(id, 'd')).toBeNull()
  })
})

describe('the option passes through createNebulaApp', () => {
  it('createNebulaApp({ files: { allowance } }) makes the API with it, so a 507 under the mount carries the same body', async () => {
    const assets = scratch('assets')
    mkdirSync(join(assets, 'app'), { recursive: true })
    writeFileSync(join(assets, 'index.html'), '<!doctype html><html><head></head><body></body></html>')
    writeFileSync(join(assets, 'routes.json'), '{}')
    const backend = createMemoryBackend()
    const { id } = await (backend.createProject as NonNullable<typeof backend.createProject>)({ name: 'Mounted' })
    const app = createNebulaApp({ basePath: '/nebula', assets, files: { backend, label: 'mounted', allowance: () => ({ bytes: 1, upgrade: '/nebula/plans' }) } })
    const ask = (method: string, path: string, body?: string) => app.fetch(new Request(`${BASE}/nebula/nebula-api/v1${path}`, { method, body })) as Promise<Response>
    try {
      const refused = await ask('PUT', `/projects/${id}/file?path=a.md`, 'x'.repeat(50))
      expect(refused?.status).toBe(507)
      expect(await refused?.json()).toMatchObject({ error: 'space-full', limit: 1, upgrade: '/nebula/plans' })
      expect(await backend.stat(id, 'a.md')).toBeNull()
      const where = await (await ask('GET', '/place'))?.json()
      expect(where.space).toMatchObject({ limit: 1, upgrade: '/nebula/plans' })
    } finally {
      (app.files as Api | null)?.close()
    }
  })
})

/** A real server over the API, on 127.0.0.1. */
async function listening(api: Api) {
  const server = createServer((req, res) => {
    void api.handle(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end()
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}

describe('a declared length that wouldn’t fit', () => {
  it('is refused before a byte of the body is read, and the connection stays usable for the next request', async () => {
    const { api, backend, id, state } = await space()
    state.limit = (await backend.usage()).bytes + 100
    // Through fetch: a body that records every pull. Nothing is pulled for a declared length that can't fit.
    let pulls = 0
    const stream = new ReadableStream({ pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(10)) } }, { highWaterMark: 0 })
    const refused = await api.fetch(new Request(`${BASE}${API}/projects/${id}/file?path=a.md`, { method: 'PUT', body: stream, duplex: 'half', headers: { 'content-length': '5000' } } as RequestInit), {}) as Response
    expect(refused.status).toBe(507)
    expect(await json(refused)).toMatchObject({ error: 'space-full' })
    expect(pulls).toBe(0)
    // A declared length that fits is read (the control: the same stream pulls).
    let fitPulls = 0
    let sent = 0
    const fits = new ReadableStream({ pull(controller) { fitPulls += 1; if (sent >= 50) controller.close(); else { sent += 10; controller.enqueue(new Uint8Array(10)) } } }, { highWaterMark: 0 })
    const stored = await api.fetch(new Request(`${BASE}${API}/projects/${id}/file?path=b.md`, { method: 'PUT', body: fits, duplex: 'half', headers: { 'content-length': '50' } } as RequestInit), {}) as Response
    expect(stored.status).toBe(200)
    expect(fitPulls).toBeGreaterThan(0)
    expect((await backend.stat(id, 'b.md'))?.entry.size).toBe(50)

    // Over a socket: the refusal leaves the connection fit for the next request.
    const port = await listening(api)
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    const send = (method: string, path: string, body?: Buffer, headers: Record<string, string> = {}) =>
      new Promise<{ status: number; reused: boolean; connection: string | undefined; text: string }>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, method, path, agent, headers }, (res) => {
          let text = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => (text += chunk))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, reused: req.reusedSocket, connection: res.headers.connection, text }))
        })
        req.on('error', reject)
        req.end(body)
      })
    try {
      const first = await send('PUT', `${API}/projects/${id}/file?path=c.md`, Buffer.alloc(3000, 120), { 'content-length': '3000' })
      expect(first.status).toBe(507)
      expect(first.connection).not.toBe('close')
      const second = await send('GET', `${API}/place`)
      expect(second.status).toBe(200)
      expect(second.reused).toBe(true)
      expect(await backend.stat(id, 'c.md')).toBeNull()
    } finally {
      agent.destroy()
    }
  })

  it('stops a chunked body of unknown length at the room left: the backend sees no more than that, and the connection closes behind the 507', async () => {
    const inner = createMemoryBackend()
    let seen = 0
    const counting = Object.assign(Object.create(inner), {
      write: async (project: string, path: string, body: AsyncIterable<Uint8Array>, options: Record<string, unknown>) =>
        inner.write(project, path, (async function* () {
          for await (const chunk of body) {
            seen += chunk.byteLength
            yield chunk
          }
        })(), options),
    })
    const { api, id, state } = await space(1_000_000, { backend: counting })
    const backend = inner
    state.limit = (await backend.usage()).bytes + 1000
    const port = await listening(api)
    // A keep-alive client, so that what closes the connection is the server's say-so and not the client's.
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    const outcome = await new Promise<{ status: number; connection: string | undefined }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method: 'PUT', path: `${API}/projects/${id}/file?path=big.md`, headers: { 'transfer-encoding': 'chunked' }, agent }, (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0, connection: res.headers.connection }))
      })
      req.on('error', (error) => {
        // The server may close the socket before the rest of the body is out; the answer is what matters.
        if ((error as NodeJS.ErrnoException).code === 'ECONNRESET' || (error as NodeJS.ErrnoException).code === 'EPIPE') return
        reject(error)
      })
      let sent = 0
      const send = () => {
        if (req.destroyed || sent >= 20_000) return req.end()
        req.write(Buffer.alloc(500, 97))
        sent += 500
        setTimeout(send, 2)
      }
      send()
    })
    agent.destroy()
    expect(outcome.status).toBe(507)
    expect(outcome.connection).toBe('close')
    expect(seen).toBeLessThanOrEqual(1000)
    expect(await backend.stat(id, 'big.md')).toBeNull()
  })
})
