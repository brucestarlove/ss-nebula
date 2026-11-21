// @vitest-environment node
// 2.0.4's history routes over the file API (cli/nebula-files.mjs): versions, version, restore and the
// removed projects' three, answered by the database backend, and refused (405 not-supported) by the
// backends that keep no history. The API is asked as a web-standard `fetch`, with no socket.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { API, createFilesApi as makeFilesApi } from '../cli/nebula-files.mjs'
import { createDatabaseBackend } from '../cli/backends/database.mjs'
import { createMemoryBackend } from '../cli/backends/memory.mjs'
import { ADA, DAY, cleanScratch, scratch } from './databaseSupport'

afterEach(cleanScratch)

/** createFilesApi, whose JSDoc types its options from their defaults. */
const createFilesApi = makeFilesApi as (options: Record<string, unknown>) => ReturnType<typeof makeFilesApi>
type Api = ReturnType<typeof makeFilesApi>
const apis: Api[] = []
afterEach(() => {
  while (apis.length) apis.pop()?.close()
})

function call(api: Api, method: string, path: string, init: { headers?: Record<string, string>; body?: string | Uint8Array } = {}) {
  return api.fetch(new Request(`http://localhost${API}${path}`, { method, headers: init.headers, body: init.body as BodyInit | undefined }), {}) as Promise<Response>
}

async function database(options: Record<string, unknown> = {}) {
  const backend = createDatabaseBackend({ folder: join(scratch('routes'), 'db'), ...options })
  const api = createFilesApi({ backend, label: 'routes' })
  apis.push(api)
  const { id } = await backend.createProject({ name: 'Routes' }, { actor: ADA })
  return { api, backend, id }
}

const save = (api: Api, id: string, path: string, text: string, headers: Record<string, string> = {}) => call(api, 'PUT', `/projects/${id}/file?path=${encodeURIComponent(path)}`, { headers, body: text })
const json = async (response: Response) => (await response.json()) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

describe('history routes on the database backend', () => {
  it('versions answers limits as the contract says: 0, 201 and 1.5 are invalid-query, 1 and 200 are allowed, and 50 is the default', async () => {
    const { api, id } = await database()
    for (let count = 0; count < 55; count += 1) expect((await save(api, id, 'n.md', `revision ${count}`)).status).toBe(200)
    const versions = (query: string) => call(api, 'GET', `/projects/${id}/versions?path=n.md${query}`)
    for (const limit of ['0', '201', '1.5', '-1', 'x']) {
      const response = await versions(`&limit=${limit}`)
      expect([limit, response.status]).toEqual([limit, 400])
      expect((await json(response)).error).toBe('invalid-query')
    }
    for (const limit of ['1', '200']) expect((await versions(`&limit=${limit}`)).status).toBe(200)
    const standard = await json(await versions(''))
    expect(standard.versions).toHaveLength(50)
    expect(standard.next).toEqual(expect.any(String))
    expect(standard.versions[0].current).toBe(true)
    // The next page, from `next`, is the rest and ends.
    const rest = await json(await versions(`&before=${encodeURIComponent(standard.next)}`))
    expect(rest.versions.length + standard.versions.length).toBe(55)
  })

  it('refuses a before or a version with characters outside a token before it reaches the backend', async () => {
    const { api, id } = await database()
    await save(api, id, 'n.md', 'one')
    for (const bad of ['a b', '../x', 'a/b', 'a%00b', "a'b", 'x'.repeat(129)]) {
      const asked = encodeURIComponent(bad)
      const before = await call(api, 'GET', `/projects/${id}/versions?path=n.md&before=${asked}`)
      expect([bad, before.status, (await json(before)).error]).toEqual([bad, 400, 'invalid-query'])
      const version = await call(api, 'GET', `/projects/${id}/version?path=n.md&version=${asked}`)
      expect([bad, version.status, (await json(version)).error]).toEqual([bad, 400, 'invalid-query'])
      const restore = await call(api, 'POST', `/projects/${id}/restore?path=n.md&version=${asked}`, { headers: { 'if-none-match': '*' } })
      expect([bad, restore.status]).toEqual([bad, 400])
    }
    // No version at all is the same refusal; a clean token that names nothing is a plain not-found.
    expect((await call(api, 'GET', `/projects/${id}/version?path=n.md`)).status).toBe(400)
    expect((await call(api, 'GET', `/projects/${id}/version?path=n.md&version=zz:9`)).status).toBe(404)
  })

  it('version sends the file’s headers plus nebula-version, the bytes whole, and HEAD sends no body', async () => {
    const { api, id } = await database()
    await save(api, id, 'n.md', 'the first words')
    await save(api, id, 'n.md', 'second')
    const [, first] = (await json(await call(api, 'GET', `/projects/${id}/versions?path=n.md`))).versions
    const path = `/projects/${id}/version?path=n.md&version=${encodeURIComponent(first.version)}`
    const got = await call(api, 'GET', path)
    expect(got.status).toBe(200)
    expect(await got.text()).toBe('the first words')
    const head = await call(api, 'HEAD', path)
    for (const response of [got, head]) {
      expect(response.headers.get('nebula-version')).toBe(first.version)
      expect(response.headers.get('etag')).toBe(`"${first.version}"`)
      expect(response.headers.get('content-length')).toBe(String('the first words'.length))
      expect(response.headers.get('content-type')).toBe('application/octet-stream')
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    }
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    // The current version reads the same way, and its ETag is the file's.
    const current = (await json(await call(api, 'GET', `/projects/${id}/versions?path=n.md`))).versions[0]
    const now = await call(api, 'GET', `/projects/${id}/version?path=n.md&version=${encodeURIComponent(current.version)}`)
    expect(await now.text()).toBe('second')
    expect(now.headers.get('etag')).toBe((await call(api, 'GET', `/projects/${id}/file?path=n.md`)).headers.get('etag'))
  })

  it('answers 404 for a version thinning dropped, never 500', async () => {
    const { api, backend, id } = await database()
    for (const text of ['one', 'two', 'three']) await save(api, id, 'n.md', text)
    const before = (await json(await call(api, 'GET', `/projects/${id}/versions?path=n.md`))).versions
    expect(before).toHaveLength(3)
    await backend.sweep({ now: Date.now() + 3 * DAY })
    const after = (await json(await call(api, 'GET', `/projects/${id}/versions?path=n.md`))).versions
    const dropped = before.filter((version: { version: string }) => !after.some((each: { version: string }) => each.version === version.version))
    expect(dropped.length).toBeGreaterThan(0)
    for (const version of dropped) {
      const response = await call(api, 'GET', `/projects/${id}/version?path=n.md&version=${encodeURIComponent(version.version)}`)
      expect([response.status, (await json(response)).error]).toEqual([404, 'not-found'])
      const restore = await call(api, 'POST', `/projects/${id}/restore?path=n.md&version=${encodeURIComponent(version.version)}`, { headers: { 'if-match': `"${after[0].version}"` } })
      expect(restore.status).toBe(404)
    }
  })

  it('restore needs If-Match or If-None-Match: * (412 without), puts the version back as the newest, and answers as a write does', async () => {
    const { api, id } = await database()
    await save(api, id, 'n.md', 'one')
    const saved = await save(api, id, 'n.md', 'two')
    const etag = String(saved.headers.get('etag'))
    const [current, first] = (await json(await call(api, 'GET', `/projects/${id}/versions?path=n.md`))).versions
    const path = `/projects/${id}/restore?path=n.md&version=${encodeURIComponent(first.version)}`
    const bare = await call(api, 'POST', path)
    expect([bare.status, (await json(bare)).error]).toEqual([412, 'precondition'])
    expect(await (await call(api, 'GET', `/projects/${id}/file?path=n.md`)).text()).toBe('two')
    // The wrong ETag, and If-None-Match over a file that is there, are 412 too.
    expect((await call(api, 'POST', path, { headers: { 'if-match': '"zz:9"' } })).status).toBe(412)
    expect((await call(api, 'POST', path, { headers: { 'if-none-match': '*' } })).status).toBe(412)
    const restored = await call(api, 'POST', path, { headers: { 'if-match': etag } })
    expect(restored.status).toBe(200)
    const answer = await json(restored)
    expect(answer.etag).toBe(restored.headers.get('etag'))
    expect(answer.entry).toMatchObject({ path: 'n.md', type: 'file', size: 3 })
    expect(answer.etag).toBe(`"${current.version.split(':')[0]}:3"`)
    expect(await (await call(api, 'GET', `/projects/${id}/file?path=n.md`)).text()).toBe('one')
    const changes = await json(await call(api, 'GET', `/changes?project=${id}&limit=1`))
    expect(changes.changes[0]).toMatchObject({ type: 'write', path: 'n.md', restoredFrom: first.version })
  })

  it('removes a project, lists it as removed, and brings it back: the three routes answer as the contract says', async () => {
    const { api, id } = await database()
    await save(api, id, 'n.md', 'kept words')
    const place = await json(await call(api, 'GET', '/place'))
    expect(place.capabilities).toMatchObject({ versions: true, removeProject: true })
    const removed = await call(api, 'DELETE', `/projects/${id}`)
    expect(removed.status).toBe(200)
    const answer = await json(removed)
    expect(answer.removed).toMatchObject({ id, name: 'Routes', removedBy: { id: expect.any(String) } })
    expect(Date.parse(answer.removed.purgeAfter) - Date.parse(answer.removed.removed)).toBe(14 * DAY)
    // Gone from the place and from every route of the project.
    expect((await json(await call(api, 'GET', '/place'))).projects.map((project: { id: string }) => project.id)).not.toContain(id)
    for (const path of ['state', 'list', 'versions?path=n.md']) {
      const response = await call(api, 'GET', `/projects/${id}/${path}`)
      expect([path, response.status, (await json(response)).error]).toEqual([path, 404, 'no-project'])
    }
    const listed = await json(await call(api, 'GET', '/removed-projects'))
    expect(listed.projects.map((project: { id: string }) => project.id)).toEqual([id])
    const back = await call(api, 'POST', `/removed-projects/${id}/restore`)
    expect(back.status).toBe(200)
    expect((await json(back)).project).toMatchObject({ id, name: 'Routes' })
    expect(await (await call(api, 'GET', `/projects/${id}/file?path=n.md`)).text()).toBe('kept words')
    expect((await json(await call(api, 'GET', '/removed-projects'))).projects).toEqual([])
    // Only DELETE removes a project: any other method on its address removes nothing.
    for (const method of ['GET', 'POST', 'PUT', 'PATCH']) {
      const response = await call(api, method, `/projects/${id}`)
      expect([method, response.status === 404 || response.status === 405]).toEqual([method, true])
      expect((await json(await call(api, 'GET', '/place'))).projects.map((project: { id: string }) => project.id)).toContain(id)
    }
    // Restoring what isn't removed, and removing what isn't there, are no-project.
    expect((await call(api, 'POST', `/removed-projects/${id}/restore`)).status).toBe(404)
    expect((await call(api, 'DELETE', '/projects/never-there')).status).toBe(404)
  })
})

describe('history routes where the backend keeps none', () => {
  async function folders() {
    const root = scratch('folders')
    mkdirSync(join(root, 'p1'))
    const api = createFilesApi({ projectsDirs: [root], label: 'routes' })
    apis.push(api)
    await api.ready()
    return { api, id: api.projects()[0].id }
  }
  async function memory() {
    const backend = createMemoryBackend()
    const api = createFilesApi({ backend, label: 'routes' })
    apis.push(api)
    const { id } = await backend.createProject?.({ name: 'Memory' }, {}) ?? { id: '' }
    return { api, id }
  }

  for (const [label, make] of [['folders', folders], ['memory', memory]] as const) {
    it(`${label}: all six answer 405 not-supported, and the place says versions: false, removeProject: false`, async () => {
      const { api, id } = await make()
      const asks: [string, string, Record<string, string>?][] = [
        ['GET', `/projects/${id}/versions?path=n.md`],
        ['GET', `/projects/${id}/version?path=n.md&version=a:1`],
        ['POST', `/projects/${id}/restore?path=n.md&version=a:1`, { 'if-none-match': '*' }],
        ['DELETE', `/projects/${id}`],
        ['GET', '/removed-projects'],
        ['POST', `/removed-projects/${id}/restore`],
      ]
      for (const [method, path, headers] of asks) {
        const response = await call(api, method, path, { headers })
        expect([method, path, response.status, (await json(response)).error]).toEqual([method, path, 405, 'not-supported'])
      }
      const place = await json(await call(api, 'GET', '/place'))
      expect(place.capabilities).toMatchObject({ versions: false, removeProject: false })
      // Nothing was removed by the asking.
      expect(place.projects.map((project: { id: string }) => project.id)).toContain(id)
    })
  }
})
