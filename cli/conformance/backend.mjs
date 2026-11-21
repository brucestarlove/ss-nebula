// The ProjectBackend's rules as cases any runner can run: the folder, memory and database backends
// here, and the Suite's own database backend over its bucket store, are held to the same ones
// (cli/backend.mjs has them in its JSDoc). The cases call the interface itself, with no HTTP, and
// read `capabilities` to leave out what a backend doesn't claim. Node built-ins only, and no test
// framework: `backendCases` gives `{ name, run }` pairs, and `register` hands them to whatever
// `describe` and `it` a runner has (vitest, node:test).
//
//   import { register } from '@starlove/nebula/conformance/backend'
//   register({ describe, it }, 'my backend', () => ({ backend: makeMyBackend() }))
//
// `makeBackend` is called once per case, so no case depends on another, and answers a backend, or
// an object with it:
//   - `backend`: the backend, new on each call (or sharing a store, with a prefix of its own);
//   - `newProject()`: makes a project and answers its id, for a backend that makes none itself
//     (`capabilities.createProject` false; folders served from `roots`). Without it, the cases use
//     `backend.createProject`;
//   - `dispose()`: cleans up after the case (a scratch folder). The backend's `close()` is called
//     for you.
// What a restart does to the log (`durableHistory`) isn't checked here: that needs the host to
// open the same storage twice, which only the host can do.
import assert from 'node:assert/strict'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const CURSOR = /^[^:]+:\d+$/
const COLOUR = /^#[0-9a-f]{6}$/

/** A value as ordinary arrays and objects of this module's own realm. A backend may answer rows
 * with no prototype (node:sqlite's), or values made in another realm (a vm context in a test
 * runner), and `assert.deepEqual` compares prototypes, which isn't a rule of the interface. */
function plain(value) {
  if (Array.isArray(value)) return Array.from(value, plain)
  if (Object.prototype.toString.call(value) === '[object Object]') return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, plain(each)]))
  return value
}

/** What the interface promises is the shape and the values, so that is what is compared. */
const same = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message)

const ACTOR = Object.freeze({ type: 'human', id: 'ada', name: 'Ada' })
const AGENT = Object.freeze({ type: 'agent', id: 'lear', name: 'Lear' })

/** The backend a call to `makeBackend` made, and how to make a project in it and clean up after. */
async function open(makeBackend) {
  const made = await makeBackend()
  const backend = typeof made?.listProjects === 'function' ? made : made?.backend
  assert.equal(typeof backend?.listProjects, 'function', 'makeBackend answers a backend, or { backend, newProject?, dispose? }')
  let count = 0
  const state = { closed: false }
  return {
    backend,
    state,
    /** A project of its own, and its id. */
    async project(options = {}) {
      if (typeof made.newProject === 'function') return made.newProject(options)
      assert.ok(backend.capabilities?.createProject === true && typeof backend.createProject === 'function', 'the backend makes no projects: makeBackend gives a newProject()')
      count += 1
      return (await backend.createProject({ name: `Conformance ${count}`, ...options }, { actor: ACTOR })).id
    },
    async dispose() {
      if (!state.closed) await backend.close()
      await made.dispose?.()
    },
  }
}

async function* body(text) {
  yield typeof text === 'string' ? encoder.encode(text) : text
}

/** A body that comes in pieces, so a write is read to its end, not from its first chunk. */
async function* pieces(text, size = 4) {
  const bytes = encoder.encode(text)
  for (let at = 0; at < bytes.byteLength; at += size) yield bytes.slice(at, at + size)
}

async function collect(stream) {
  const reader = stream.getReader()
  const chunks = []
  let length = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    chunks.push(value)
    length += value.byteLength
  }
  const all = new Uint8Array(length)
  let at = 0
  for (const chunk of chunks) {
    all.set(chunk, at)
    at += chunk.byteLength
  }
  return all
}

const put = (backend, id, path, text, options) => backend.write(id, path, body(text), options)

async function textOf(backend, id, path) {
  const file = await backend.read(id, path)
  return decoder.decode(await collect(file.body))
}

const pathsOf = async (backend, id) => (await backend.list(id)).map((entry) => entry.path).sort()

/** Rejects with a code, and with the details the client reads (`extra`) when they're given. */
async function refusedWith(promise, code, extra) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code, `rejected with ${error?.code ?? error}, not ${code}`)
    if (extra) same({ ...error.extra }, extra, `the details of ${code}`)
    return true
  })
}

/** Waits for a condition that a feed or a watcher may take a moment to bring about. */
async function until(check, what, ms = 3000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) assert.fail(`waited ${ms} ms for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The records after a cursor, or fails when the backend asks for a resync. */
async function recordsSince(backend, id, cursor) {
  const since = await backend.changesSince(id, cursor)
  assert.ok(!since.resync, 'a cursor the backend gave is still good')
  return since.changes
}

/** The cases, each `{ name, run }`; `run` throws when the backend breaks a rule. */
export function backendCases(makeBackend) {
  const cases = []
  /** `body(backend, project, context)`: `project()` makes a project of its own. `needs` names a capability. */
  const add = (name, run, { needs } = {}) =>
    cases.push({
      name,
      needs,
      async run() {
        const context = await open(makeBackend)
        try {
          if (needs && context.backend.capabilities?.[needs] !== true) return // not claimed: nothing to hold it to
          await run(context.backend, context.project, context)
        } finally {
          await context.dispose()
        }
      },
    })

  // --- projects --------------------------------------------------------------------------------

  add('a new project is listed, answers project(id) with its info, and keeps its identity in .nebula/project.json', async (backend, project) => {
    const id = await project()
    const listed = (await backend.listProjects()).find((each) => each.id === id)
    assert.ok(listed, 'listProjects has it')
    const info = await backend.project(id)
    assert.equal(info.id, id)
    assert.equal(typeof info.name, 'string')
    assert.match(info.color, COLOUR)
    assert.equal(typeof info.created, 'string')
    assert.equal(typeof info.createdBy, 'string')
    const meta = JSON.parse(await textOf(backend, id, '.nebula/project.json'))
    assert.equal(meta.id, id)
  })

  add('every method on a project that isn’t there rejects with no-project', async (backend) => {
    const id = 'nope-no-such-project'
    const calls = [
      () => backend.project(id),
      () => backend.cursor(id),
      () => backend.list(id),
      () => backend.stat(id, 'a.md'),
      () => backend.read(id, 'a.md'),
      () => put(backend, id, 'a.md', 'x'),
      () => backend.mkdir(id, 'd'),
      () => backend.rename(id, 'a.md', 'b.md'),
      () => backend.remove(id, 'a.md'),
      () => backend.changesSince(id, 'x:0'),
      () => backend.subscribe(id, { change() {}, end() {} }),
      () => backend.usage(id),
    ]
    for (const call of calls) await refusedWith(call(), 'no-project')
  })

  add('createProject takes a name and a colour, names its creator, and refuses a taken id', async (backend) => {
    const made = await backend.createProject({ name: 'Orion', color: '#4ade80' }, { actor: AGENT })
    assert.equal(made.name, 'Orion')
    assert.equal(made.color, '#4ade80')
    assert.equal(made.createdBy, AGENT.id)
    assert.match(made.created, /^\d{4}-\d\d-\d\dT/)
    assert.equal((await backend.project(made.id)).name, 'Orion')
    await refusedWith(backend.createProject({ id: made.id, name: 'Again' }, { actor: AGENT }), 'exists')
    // A name left out is still a project, with a name and a colour of its own.
    const plain = await backend.createProject({ name: '  ' }, { actor: ACTOR })
    assert.ok(plain.name.length > 0)
    assert.match(plain.color, COLOUR)
    assert.notEqual(plain.id, made.id)
  }, { needs: 'createProject' })

  // --- writing and reading ---------------------------------------------------------------------

  add('write replaces the whole file: longer, then shorter, then empty', async (backend, project) => {
    const id = await project()
    const first = await put(backend, id, 'note.md', 'one')
    assert.equal(first.entry.path, 'note.md')
    assert.equal(first.entry.type, 'file')
    assert.equal(first.entry.size, 3)
    assert.equal(await textOf(backend, id, 'note.md'), 'one')
    await put(backend, id, 'note.md', 'a much longer second version')
    assert.equal(await textOf(backend, id, 'note.md'), 'a much longer second version')
    await put(backend, id, 'note.md', 'x')
    assert.equal(await textOf(backend, id, 'note.md'), 'x')
    assert.equal((await backend.stat(id, 'note.md')).entry.size, 1)
    await put(backend, id, 'note.md', '')
    assert.equal(await textOf(backend, id, 'note.md'), '')
    assert.equal((await backend.stat(id, 'note.md')).entry.size, 0)
  })

  add('write keeps every byte of a body that comes in pieces, binary and larger than a chunk', async (backend, project) => {
    const id = await project()
    const bytes = new Uint8Array(300_000)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31 + (index >> 8)) % 256
    async function* parts() {
      for (let at = 0; at < bytes.length; at += 10_007) yield bytes.slice(at, at + 10_007)
    }
    const written = await backend.write(id, 'data.bin', parts())
    assert.equal(written.entry.size, bytes.length)
    const read = await backend.read(id, 'data.bin')
    assert.equal(read.size, bytes.length)
    same(await collect(read.body), bytes)
    assert.equal((await put(backend, id, 'text.md', 'héllo ✓ — ünïcode')).entry.size, encoder.encode('héllo ✓ — ünïcode').length)
    assert.equal(await textOf(backend, id, 'text.md'), 'héllo ✓ — ünïcode')
  })

  add('write answers its entry, a version, and a cursor, and the version is the one stat and read give', async (backend, project) => {
    const id = await project()
    const written = await put(backend, id, 'a/b.md', 'hello', { actor: ACTOR })
    assert.equal(typeof written.version, 'string')
    assert.ok(written.version.length > 0)
    assert.match(written.cursor, CURSOR)
    assert.equal(written.entry.name, 'b.md')
    assert.equal(typeof written.entry.modified, 'number')
    assert.equal((await backend.stat(id, 'a/b.md')).version, written.version)
    assert.equal((await backend.read(id, 'a/b.md').then(async (file) => (await file.body.cancel(), file))).version, written.version)
    const second = await put(backend, id, 'a/b.md', 'hello, again', { actor: ACTOR })
    assert.notEqual(second.version, written.version, 'new bytes are a new version')
    assert.equal((await backend.stat(id, 'a/b.md')).version, second.version)
  })

  add('write makes the folders on the way, as folders', async (backend, project) => {
    const id = await project()
    await put(backend, id, 'one/two/three.md', 'deep')
    const entries = await backend.list(id)
    for (const folder of ['one', 'one/two']) assert.equal(entries.find((entry) => entry.path === folder)?.type, 'dir', folder)
    assert.equal(entries.find((entry) => entry.path === 'one/two/three.md')?.type, 'file')
  })

  add('a write whose body fails changes nothing: the old file stays, and no change is recorded', async (backend, project) => {
    const id = await project()
    await put(backend, id, 'keep.md', 'the first version')
    const cursor = await backend.cursor(id)
    const boom = new Error('the sender went away')
    async function* failing() {
      yield encoder.encode('half of a new ver')
      throw boom
    }
    await assert.rejects(backend.write(id, 'keep.md', failing()))
    assert.equal(await textOf(backend, id, 'keep.md'), 'the first version')
    await assert.rejects(backend.write(id, 'never.md', failing()))
    assert.equal(await backend.stat(id, 'never.md'), null)
    assert.equal(await backend.cursor(id), cursor)
  })

  add('a read is the file as it was at one moment: a write after it opens doesn’t change what it gives', async (backend, project) => {
    const id = await project()
    await put(backend, id, 'a.md', 'before the write, '.repeat(10))
    const file = await backend.read(id, 'a.md')
    await put(backend, id, 'a.md', 'after')
    assert.equal(decoder.decode(await collect(file.body)), 'before the write, '.repeat(10))
    assert.equal(await textOf(backend, id, 'a.md'), 'after')
  })

  add('stat gives null for nothing, an entry and a version for a file, and no version for a folder', async (backend, project) => {
    const id = await project()
    assert.equal(await backend.stat(id, 'nothing.md'), null)
    await put(backend, id, 'dir/file.md', 'x')
    const file = await backend.stat(id, 'dir/file.md')
    assert.equal(file.entry.type, 'file')
    assert.equal(typeof file.version, 'string')
    const dir = await backend.stat(id, 'dir')
    assert.equal(dir.entry.type, 'dir')
    assert.equal(dir.version, null)
  })

  add('read of nothing is not-found, of a folder isn’t a file, and a write through a file is refused', async (backend, project) => {
    const id = await project()
    await refusedWith(backend.read(id, 'nothing.md'), 'not-found')
    await put(backend, id, 'dir/file.md', 'x')
    await refusedWith(backend.read(id, 'dir'), 'type')
    await refusedWith(put(backend, id, 'dir', 'now a file?'), 'type')
    await refusedWith(put(backend, id, 'dir/file.md/inside.md', 'x'), 'type')
    assert.equal(await textOf(backend, id, 'dir/file.md'), 'x')
  })

  add('list gives every file and folder with its path, name, type, size, time and version, and never .nebula', async (backend, project) => {
    const id = await project()
    await put(backend, id, 'top.md', 'abc', { actor: ACTOR })
    await put(backend, id, 'sub/inner.md', 'abcdef', { actor: ACTOR })
    await backend.mkdir(id, 'empty')
    const entries = await backend.list(id)
    same(entries.map((entry) => entry.path).sort(), ['empty', 'sub', 'sub/inner.md', 'top.md'])
    const top = entries.find((entry) => entry.path === 'top.md')
    assert.equal(top.name, 'top.md')
    assert.equal(top.type, 'file')
    assert.equal(top.size, 3)
    assert.equal(typeof top.modified, 'number')
    assert.equal(top.version, (await backend.stat(id, 'top.md')).version, 'list and stat say the same version')
    assert.equal(entries.find((entry) => entry.path === 'sub/inner.md').name, 'inner.md')
    assert.equal(entries.find((entry) => entry.path === 'empty').type, 'dir')
    assert.ok(!entries.some((entry) => entry.path === '.nebula' || entry.path.startsWith('.nebula/')))
  })

  add('a file’s entry names who last wrote it through Nebula', async (backend, project) => {
    const id = await project()
    await put(backend, id, 'a.md', 'by ada', { actor: ACTOR })
    same((await backend.stat(id, 'a.md')).entry.modifiedBy, ACTOR)
    same((await backend.list(id)).find((entry) => entry.path === 'a.md').modifiedBy, ACTOR)
    await put(backend, id, 'a.md', 'by lear', { actor: AGENT })
    same((await backend.stat(id, 'a.md')).entry.modifiedBy, AGENT)
    // The name follows a rename.
    await backend.rename(id, 'a.md', 'b.md', { actor: ACTOR })
    same((await backend.stat(id, 'b.md')).entry.modifiedBy, AGENT)
  })

  // --- preconditions ---------------------------------------------------------------------------

  add('ifMatch writes over the version it names, and a stale one is refused with 412 and absent: false', async (backend, project) => {
    const id = await project()
    const first = await put(backend, id, 'a.md', 'v1')
    const second = await put(backend, id, 'a.md', 'v2', { ifMatch: first.version })
    assert.notEqual(second.version, first.version)
    await refusedWith(put(backend, id, 'a.md', 'v3 from a stale page', { ifMatch: first.version }), 'precondition', { absent: false })
    assert.equal(await textOf(backend, id, 'a.md'), 'v2', 'a refused write changes nothing')
    const third = await put(backend, id, 'a.md', 'v3', { ifMatch: second.version })
    assert.equal(await textOf(backend, id, 'a.md'), 'v3')
    assert.equal((await backend.stat(id, 'a.md')).version, third.version)
  })

  add('ifMatch on a file that is gone is refused with 412 and absent: true, and writes nothing', async (backend, project) => {
    const id = await project()
    const first = await put(backend, id, 'a.md', 'v1')
    await backend.remove(id, 'a.md')
    await refusedWith(put(backend, id, 'a.md', 'back?', { ifMatch: first.version }), 'precondition', { absent: true })
    assert.equal(await backend.stat(id, 'a.md'), null)
    await refusedWith(put(backend, id, 'never-was.md', 'x', { ifMatch: first.version }), 'precondition', { absent: true })
    assert.equal(await backend.stat(id, 'never-was.md'), null)
  })

  add('ifAbsent creates only: a path that is taken is refused with 412 and exists: true', async (backend, project) => {
    const id = await project()
    await put(backend, id, 'new.md', 'mine', { ifAbsent: true })
    await refusedWith(put(backend, id, 'new.md', 'theirs', { ifAbsent: true }), 'precondition', { exists: true })
    assert.equal(await textOf(backend, id, 'new.md'), 'mine')
    await backend.mkdir(id, 'folder')
    await refusedWith(put(backend, id, 'folder', 'x', { ifAbsent: true }), 'precondition', { exists: true })
  })

  add('a refused precondition leaves no change in the log', async (backend, project) => {
    const id = await project()
    const first = await put(backend, id, 'a.md', 'v1')
    await put(backend, id, 'a.md', 'v2')
    const cursor = await backend.cursor(id)
    await assert.rejects(put(backend, id, 'a.md', 'stale', { ifMatch: first.version }))
    await assert.rejects(put(backend, id, 'a.md', 'taken', { ifAbsent: true }))
    assert.equal(await backend.cursor(id), cursor)
    same(await recordsSince(backend, id, cursor), [])
  })

  add('with parents: false, a folder that is gone is not-found, and a write never brings it back', async (backend, project) => {
    const id = await project()
    await put(backend, id, 'gone/first.md', 'x')
    await backend.remove(id, 'gone')
    await refusedWith(put(backend, id, 'gone/second.md', 'y', { parents: false }), 'not-found')
    assert.equal(await backend.stat(id, 'gone'), null)
    assert.equal(await backend.stat(id, 'gone/second.md'), null)
    // With the folder there, or at the top, it writes; and by default it makes the folders.
    await backend.mkdir(id, 'there')
    await put(backend, id, 'there/ok.md', 'y', { parents: false })
    await put(backend, id, 'top.md', 'y', { parents: false })
    await put(backend, id, 'gone/third.md', 'z')
    assert.equal(await textOf(backend, id, 'gone/third.md'), 'z')
  })

  // --- folders, renames, removes ---------------------------------------------------------------

  add('mkdir makes a folder with its parents, and says changed: false when it was there', async (backend, project) => {
    const id = await project()
    const made = await backend.mkdir(id, 'a/b/c')
    assert.equal(made.changed, true)
    assert.match(made.cursor, CURSOR)
    same(await pathsOf(backend, id), ['a', 'a/b', 'a/b/c'])
    const cursor = await backend.cursor(id)
    const again = await backend.mkdir(id, 'a/b')
    assert.equal(again.changed, false)
    assert.equal(await backend.cursor(id), cursor, 'a folder that was there is no change')
    await put(backend, id, 'file.md', 'x')
    await refusedWith(backend.mkdir(id, 'file.md'), 'type')
    await refusedWith(backend.mkdir(id, 'file.md/inside'), 'type')
  })

  add('rename moves a file with its bytes, and its version follows it', async (backend, project) => {
    const id = await project()
    const written = await put(backend, id, 'old.md', 'the same bytes')
    await backend.rename(id, 'old.md', 'new.md')
    assert.equal(await backend.stat(id, 'old.md'), null)
    assert.equal(await textOf(backend, id, 'new.md'), 'the same bytes')
    assert.equal((await backend.stat(id, 'new.md')).version, written.version, 'a page holding the old version can still write over it')
    await put(backend, id, 'new.md', 'edited after the move', { ifMatch: written.version })
  })

  add('rename moves a folder and all in it, each file keeping its version', async (backend, project) => {
    const id = await project()
    const one = await put(backend, id, 'from/one.md', 'one')
    const two = await put(backend, id, 'from/deep/two.md', 'two')
    await backend.rename(id, 'from', 'to')
    same(await pathsOf(backend, id), ['to', 'to/deep', 'to/deep/two.md', 'to/one.md'])
    assert.equal(await textOf(backend, id, 'to/deep/two.md'), 'two')
    assert.equal((await backend.stat(id, 'to/one.md')).version, one.version)
    assert.equal((await backend.stat(id, 'to/deep/two.md')).version, two.version)
  })

  add('rename refuses an existing target (exists), a missing source (not-found), and changes nothing', async (backend, project) => {
    const id = await project()
    await put(backend, id, 'a.md', 'a')
    await put(backend, id, 'b.md', 'b')
    await backend.mkdir(id, 'folder')
    const cursor = await backend.cursor(id)
    await refusedWith(backend.rename(id, 'a.md', 'b.md'), 'exists')
    await refusedWith(backend.rename(id, 'a.md', 'folder'), 'exists')
    await refusedWith(backend.rename(id, 'nothing.md', 'c.md'), 'not-found')
    assert.equal(await textOf(backend, id, 'a.md'), 'a')
    assert.equal(await textOf(backend, id, 'b.md'), 'b')
    assert.equal(await backend.cursor(id), cursor)
  })

  add('rename refuses a folder into itself or into what is in it (into-itself)', async (backend, project) => {
    const id = await project()
    await put(backend, id, 'f/inner/x.md', 'x')
    await refusedWith(backend.rename(id, 'f', 'f/inside'), 'into-itself')
    await refusedWith(backend.rename(id, 'f', 'f/inner/deeper'), 'into-itself')
    same(await pathsOf(backend, id), ['f', 'f/inner', 'f/inner/x.md'])
  })

  add('remove takes a file, and a folder with all in it, and a path that isn’t there is not-found', async (backend, project) => {
    const id = await project()
    await put(backend, id, 'a.md', 'a')
    await put(backend, id, 'dir/b.md', 'b')
    await put(backend, id, 'dir/deep/c.md', 'c')
    await put(backend, id, 'keep.md', 'k')
    const removed = await backend.remove(id, 'a.md')
    assert.match(removed.cursor, CURSOR)
    assert.equal(await backend.stat(id, 'a.md'), null)
    await refusedWith(backend.read(id, 'a.md'), 'not-found')
    await backend.remove(id, 'dir')
    same(await pathsOf(backend, id), ['keep.md'])
    await refusedWith(backend.remove(id, 'dir'), 'not-found')
    await refusedWith(backend.remove(id, 'a.md'), 'not-found')
    // The same name can be made again.
    await put(backend, id, 'a.md', 'again', { ifAbsent: true })
    assert.equal(await textOf(backend, id, 'a.md'), 'again')
  })

  // --- names -----------------------------------------------------------------------------------

  add('a path Nebula’s rules refuse is invalid-path, for every method that takes one', async (backend, project) => {
    const id = await project()
    const bad = ['', '/abs.md', 'a//b.md', './a.md', '../a.md', 'a/../b.md', 'a\\b.md', 'a\u0000b.md', 'x'.repeat(256)]
    for (const path of bad) {
      await refusedWith(backend.stat(id, path), 'invalid-path')
      await refusedWith(backend.read(id, path), 'invalid-path')
      await refusedWith(put(backend, id, path, 'x'), 'invalid-path')
      await refusedWith(backend.mkdir(id, path), 'invalid-path')
      await refusedWith(backend.remove(id, path), 'invalid-path')
    }
    await put(backend, id, 'ok.md', 'x')
    await refusedWith(backend.rename(id, 'ok.md', '../out.md'), 'invalid-path')
    await refusedWith(backend.rename(id, '', 'out.md'), 'invalid-path')
    same(await pathsOf(backend, id), ['ok.md'])
  })

  add('hidden names are never served, made or listed: dot files, node_modules, OS files, .crswap', async (backend, project) => {
    const id = await project()
    const hidden = ['.env', '.git/config', 'sub/.secret', 'node_modules/pkg/index.js', 'NODE_MODULES/x.js', 'Thumbs.db', 'desktop.ini', 'draft.md.crswap']
    for (const path of hidden) {
      await refusedWith(put(backend, id, path, 'x'), 'hidden')
      await refusedWith(backend.read(id, path), 'hidden')
      await refusedWith(backend.stat(id, path), 'hidden')
      await refusedWith(backend.mkdir(id, path), 'hidden')
      await refusedWith(backend.remove(id, path), 'hidden')
    }
    await put(backend, id, 'visible.md', 'x')
    await refusedWith(backend.rename(id, 'visible.md', '.hidden.md'), 'hidden')
    await refusedWith(backend.rename(id, 'visible.md', 'node_modules'), 'hidden')
    same(await pathsOf(backend, id), ['visible.md'])
    // A name that only looks like one is a name.
    await put(backend, id, 'node_modules2/ok.md', 'x')
    await put(backend, id, 'Thumbs.db.md', 'x')
  })

  add('.nebula is the project’s own: plain names inside it are served, nothing moves in or out, and it isn’t removed', async (backend, project) => {
    const id = await project()
    await put(backend, id, '.nebula/workspace.json', '{"open":[]}')
    assert.equal(await textOf(backend, id, '.nebula/workspace.json'), '{"open":[]}')
    assert.equal((await backend.stat(id, '.nebula/workspace.json')).entry.type, 'file')
    await refusedWith(put(backend, id, '.nebula/.hidden', 'x'), 'hidden')
    await refusedWith(put(backend, id, '.nebula/sub/.hidden', 'x'), 'hidden')
    await put(backend, id, 'note.md', 'x')
    await refusedWith(backend.rename(id, 'note.md', '.nebula/note.md'), 'hidden')
    await refusedWith(backend.rename(id, '.nebula/workspace.json', 'workspace.json'), 'hidden')
    await refusedWith(backend.rename(id, '.nebula', 'moved'), 'hidden')
    await refusedWith(backend.remove(id, '.nebula'), 'hidden')
    assert.ok(!(await backend.list(id)).some((entry) => entry.path.startsWith('.nebula')), 'list never shows it')
    assert.equal(await textOf(backend, id, '.nebula/workspace.json'), '{"open":[]}')
  })

  add('project.json written through the API stays the project’s: JSON, its id unchanged, under a megabyte', async (backend, project) => {
    const id = await project()
    const meta = JSON.parse(await textOf(backend, id, '.nebula/project.json'))
    await refusedWith(put(backend, id, '.nebula/project.json', 'not json'), 'project-meta')
    await refusedWith(put(backend, id, '.nebula/project.json', JSON.stringify({ ...meta, id: 'someone-elses-id' })), 'project-meta')
    await refusedWith(put(backend, id, '.nebula/project.json', '[]'), 'project-meta')
    await refusedWith(put(backend, id, '.nebula/project.json', JSON.stringify({ ...meta, notes: 'x'.repeat(1024 * 1024) })), 'too-large')
    assert.equal(JSON.parse(await textOf(backend, id, '.nebula/project.json')).id, id, 'a refused write changes nothing')
    // Its own id, a new name and colour: a fresh look (listProjects) says so, and project(id) after it.
    await put(backend, id, '.nebula/project.json', JSON.stringify({ ...meta, name: 'Renamed in place', color: '#38d1eb' }))
    const looked = (await backend.listProjects()).find((each) => each.id === id)
    assert.equal(looked.name, 'Renamed in place')
    assert.equal(looked.color, '#38d1eb')
    assert.equal((await backend.project(id)).name, 'Renamed in place')
  })

  // --- the log ---------------------------------------------------------------------------------

  add('the cursor moves with every change, as `<epoch>:<seq>`, and not with a read', async (backend, project) => {
    const id = await project()
    const start = await backend.cursor(id)
    assert.match(start, CURSOR)
    await backend.list(id)
    await backend.stat(id, 'a.md')
    assert.equal(await backend.cursor(id), start)
    const written = await put(backend, id, 'a.md', 'x')
    const after = await backend.cursor(id)
    assert.notEqual(after, start)
    assert.equal(written.cursor, after, 'a change’s cursor is the project’s once it is in')
    assert.equal(after.slice(0, after.lastIndexOf(':')), start.slice(0, start.lastIndexOf(':')), 'one epoch')
    assert.ok(Number(after.slice(after.lastIndexOf(':') + 1)) > Number(start.slice(start.lastIndexOf(':') + 1)))
  })

  add('changesSince gives the records after a cursor in order, each with who, when and what', async (backend, project) => {
    const id = await project()
    const start = await backend.cursor(id)
    const a = await put(backend, id, 'log/a.md', 'a', { actor: ACTOR, context: 'orbit:card/main/7', client: 'page-one-xyz' })
    await put(backend, id, 'log/a.md', 'a2', { actor: AGENT })
    const m = await backend.mkdir(id, 'log/dir', { actor: ACTOR })
    const r = await backend.rename(id, 'log/a.md', 'log/b.md', { actor: ACTOR })
    const d = await backend.remove(id, 'log/b.md', { actor: AGENT })
    const records = await recordsSince(backend, id, start)
    const ours = records.filter((record) => (record.path ?? record.to ?? '').startsWith('log'))
    same(ours.map((record) => record.type), ['write', 'write', 'mkdir', 'rename', 'remove'])
    // Each record's cursor is the project's once it is in: the cursors the calls gave.
    same(ours.map((record) => record.cursor), [a.cursor, ours[1].cursor, m.cursor, r.cursor, d.cursor])
    for (const record of ours) {
      assert.match(record.cursor, CURSOR)
      assert.equal(record.project, id)
      assert.match(record.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
      assert.equal(typeof record.seq, 'number')
    }
    for (let index = 1; index < records.length; index += 1) assert.ok(records[index].seq > records[index - 1].seq, 'in order')
    same(ours[0], { ...ours[0], path: 'log/a.md', actor: ACTOR, context: 'orbit:card/main/7', client: 'page-one-xyz' })
    same(ours[1].actor, AGENT)
    assert.equal(ours[1].context, undefined)
    assert.equal(ours[2].path, 'log/dir')
    same([ours[3].from, ours[3].to], ['log/a.md', 'log/b.md'])
    assert.equal(ours[3].path, undefined)
    assert.equal(ours[4].path, 'log/b.md')
    same(ours[4].actor, AGENT)
  })

  add('changesSince the current cursor is empty, and from a middle cursor it gives only the rest', async (backend, project) => {
    const id = await project()
    const first = await put(backend, id, 'a.md', '1')
    const second = await put(backend, id, 'b.md', '2')
    await put(backend, id, 'c.md', '3')
    const rest = await recordsSince(backend, id, first.cursor)
    same(rest.map((record) => record.path), ['b.md', 'c.md'])
    assert.equal(rest[0].cursor, second.cursor)
    const now = await backend.changesSince(id, await backend.cursor(id))
    same(now.changes, [])
    assert.equal(now.cursor, await backend.cursor(id))
  })

  add('changesSince answers resync for another epoch’s cursor, one ahead of the project, or none at all', async (backend, project) => {
    const id = await project()
    const written = await put(backend, id, 'a.md', 'x')
    const epoch = written.cursor.slice(0, written.cursor.lastIndexOf(':'))
    const seq = Number(written.cursor.slice(written.cursor.lastIndexOf(':') + 1))
    for (const cursor of ['someone-elses-epoch:1', `${epoch}:${seq + 5}`, '', 'garbage', `${epoch}:-1`, `${epoch}:x`]) {
      const since = await backend.changesSince(id, cursor)
      assert.equal(since.resync, true, `cursor ${JSON.stringify(cursor)}`)
      assert.equal(since.changes, undefined)
      assert.equal(since.cursor, await backend.cursor(id), 'resync says where the project is now')
    }
    // The project's own epoch, from its start, is no resync.
    const fresh = await project()
    assert.ok(!(await backend.changesSince(fresh, await backend.cursor(fresh))).resync)
  })

  add('a change made through Nebula by an actor names that actor on its record, and without one names none', async (backend, project) => {
    const id = await project()
    const start = await backend.cursor(id)
    await put(backend, id, 'with.md', 'x', { actor: ACTOR })
    const records = await recordsSince(backend, id, start)
    same(records.find((record) => record.path === 'with.md').actor, ACTOR)
    assert.equal(Object.hasOwn(records.find((record) => record.path === 'with.md'), 'client'), false, 'what no one said isn’t there')
  })

  // --- recent ----------------------------------------------------------------------------------

  add('recent lists the newest changes first, across the backend’s projects, and filters by project', async (backend, project) => {
    const one = await project()
    const two = await project()
    await put(backend, one, 'rc/a.md', '1', { actor: ACTOR })
    await put(backend, two, 'rc/b.md', '2', { actor: AGENT })
    await put(backend, one, 'rc/c.md', '3', { actor: ACTOR })
    const all = (await backend.recent({ path: 'rc' })).changes
    same(all.map((record) => record.path), ['rc/c.md', 'rc/b.md', 'rc/a.md'])
    same(all.map((record) => record.project), [one, two, one])
    same((await backend.recent({ project: one, path: 'rc' })).changes.map((record) => record.path), ['rc/c.md', 'rc/a.md'])
    same((await backend.recent({ project: two, path: 'rc' })).changes.map((record) => record.path), ['rc/b.md'])
    same(all[1].actor, AGENT)
    assert.ok((await backend.recent()).changes.length >= 3, 'no query at all is a first page')
    same((await backend.recent({ project: one, path: 'nothing-here' })).changes, [])
  })

  add('recent pages with limit and before: each page continues where the last stopped, and the last has no next', async (backend, project) => {
    const id = await project()
    const wrote = []
    for (let count = 1; count <= 7; count += 1) {
      await put(backend, id, `pg/${count}.md`, String(count))
      wrote.push(`pg/${count}.md`)
    }
    const seen = []
    let before
    let pages = 0
    do {
      const page = await backend.recent({ project: id, path: 'pg', limit: 3, before })
      assert.ok(page.changes.length <= 3, 'a page is at most the limit')
      seen.push(...page.changes.map((record) => record.path))
      before = page.next ?? undefined
      pages += 1
      assert.ok(pages <= 5, 'paging ends')
    } while (before !== undefined)
    same(seen, wrote.reverse(), 'every change once, newest first')
    assert.equal((await backend.recent({ project: id, path: 'pg', limit: 2 })).changes.length, 2)
  })

  add('recent’s path filter takes a file, or a folder and all in it, and counts a rename at both ends', async (backend, project) => {
    const id = await project()
    await put(backend, id, 'pf/dir/a.md', 'a')
    await put(backend, id, 'pf/dir/deep/b.md', 'b')
    await put(backend, id, 'pf/other.md', 'o')
    await put(backend, id, 'pf/dirty.md', 'not in dir')
    const folder = (await backend.recent({ project: id, path: 'pf/dir' })).changes.map((record) => record.path)
    same(folder.sort(), ['pf/dir/a.md', 'pf/dir/deep/b.md'])
    same((await backend.recent({ project: id, path: 'pf/other.md' })).changes.map((record) => record.path), ['pf/other.md'])
    await backend.rename(id, 'pf/other.md', 'pf/moved.md', { actor: ACTOR })
    for (const end of ['pf/other.md', 'pf/moved.md']) {
      const changes = (await backend.recent({ project: id, path: end })).changes
      assert.equal(changes[0].type, 'rename', `at ${end}`)
      same([changes[0].from, changes[0].to], ['pf/other.md', 'pf/moved.md'])
    }
  })

  // --- the feed --------------------------------------------------------------------------------

  add('subscribe hears a change made after it, with the record changesSince gives, and stops when told', async (backend, project) => {
    const id = await project()
    const heard = []
    const stop = await backend.subscribe(id, { change: (record) => heard.push(record), end() {} })
    assert.equal(typeof stop, 'function')
    const start = await backend.cursor(id)
    await put(backend, id, 'live.md', 'x', { actor: ACTOR, client: 'page-two-xyz' })
    await until(() => heard.length >= 1, 'the feed to hear the write')
    assert.equal(heard[0].type, 'write')
    assert.equal(heard[0].path, 'live.md')
    same(heard[0].actor, ACTOR)
    assert.equal(heard[0].client, 'page-two-xyz')
    same(heard[0], (await recordsSince(backend, id, start)).find((record) => record.path === 'live.md'))
    await backend.mkdir(id, 'live-dir')
    await until(() => heard.some((record) => record.type === 'mkdir'), 'the feed to hear the folder')
    stop()
    const count = heard.length
    await put(backend, id, 'after-stop.md', 'y')
    await pause(150)
    assert.equal(heard.length, count, 'a stopped subscriber hears nothing more')
  })

  add('subscribe tells every listener of its project, and none of another project’s changes', async (backend, project) => {
    const one = await project()
    const two = await project()
    const a = []
    const b = []
    const elsewhere = []
    const stops = [
      await backend.subscribe(one, { change: (record) => a.push(record), end() {} }),
      await backend.subscribe(one, { change: (record) => b.push(record), end() {} }),
      await backend.subscribe(two, { change: (record) => elsewhere.push(record), end() {} }),
    ]
    await put(backend, one, 'hear.md', 'x')
    await until(() => a.length >= 1 && b.length >= 1, 'both listeners to hear')
    await pause(100)
    same(a.map((record) => record.path), ['hear.md'])
    same(b.map((record) => record.path), ['hear.md'])
    same(elsewhere, [])
    for (const stop of stops) stop()
  })

  add('close ends every feed, so its clients reconnect and resync', async (backend, project, context) => {
    const id = await project()
    let ended = 0
    await backend.subscribe(id, { change() {}, end: () => (ended += 1) })
    await backend.subscribe(id, { change() {}, end: () => (ended += 1) })
    context.state.closed = true
    await backend.close()
    await until(() => ended === 2, 'both feeds to end')
  })

  // --- usage -----------------------------------------------------------------------------------

  add('usage counts the current files’ bytes: writes add, an overwrite replaces, a remove frees, folders and renames cost nothing', async (backend, project) => {
    const id = await project()
    const base = await backend.usage(id)
    assert.equal(typeof base.bytes, 'number')
    assert.equal(typeof base.files, 'number')
    await put(backend, id, 'u/a.md', 'x'.repeat(10))
    await put(backend, id, 'u/b.md', 'y'.repeat(20))
    let now = await backend.usage(id)
    assert.equal(now.bytes - base.bytes, 30)
    assert.equal(now.files - base.files, 2)
    // Replacing a file counts the new bytes, never the old ones as well: history isn't usage.
    for (let count = 0; count < 5; count += 1) await put(backend, id, 'u/a.md', String(count).repeat(5))
    now = await backend.usage(id)
    assert.equal(now.bytes - base.bytes, 25)
    assert.equal(now.files - base.files, 2)
    await backend.mkdir(id, 'u/folder')
    await backend.rename(id, 'u/b.md', 'u/folder/b.md')
    same(await backend.usage(id), now)
    await backend.remove(id, 'u/folder')
    now = await backend.usage(id)
    assert.equal(now.bytes - base.bytes, 5)
    assert.equal(now.files - base.files, 1)
  })

  add('usage with no project is the whole backend’s: a write in any project adds its bytes', async (backend, project) => {
    const one = await project()
    const two = await project()
    const before = await backend.usage()
    await put(backend, one, 'w.md', 'a'.repeat(40))
    await put(backend, two, 'w.md', 'b'.repeat(60))
    const after = await backend.usage()
    assert.equal(after.bytes - before.bytes, 100)
    assert.equal(after.files - before.files, 2)
    const each = (await backend.usage(one)).bytes + (await backend.usage(two)).bytes
    assert.ok(after.bytes >= each, 'the whole is at least the sum of these two')
  })

  // --- history: versions, restore, thinning (capabilities.versions) -----------------------------

  /** Every version of a file, page after page; a page that fills its limit may be followed by an empty one. */
  async function allVersions(backend, id, path, limit = 50) {
    const all = []
    let before
    for (let pages = 0; pages < 200; pages += 1) {
      const page = await backend.versions(id, path, { limit, before })
      assert.ok(page.versions.length <= limit, 'a page holds at most its limit')
      all.push(...page.versions)
      if (page.next === null) return all
      before = page.next
    }
    return assert.fail('the pages of versions never ended')
  }

  add('versions lists a file’s kept versions newest first, the current one first, each with its time, size, actor, context and path; a path no file was at is not-found, a folder is type', async (backend, project) => {
    const id = await project()
    await put(backend, id, 'dir/doc.md', 'one', { actor: ACTOR })
    await put(backend, id, 'dir/doc.md', 'two!', { actor: AGENT, context: 'orbit:card/board/1' })
    await put(backend, id, 'dir/doc.md', 'three!!', { actor: ACTOR })
    const { versions, next } = await backend.versions(id, 'dir/doc.md')
    assert.equal(next, null)
    same(versions.map((version) => version.size), [7, 4, 3])
    same(versions.map((version) => version.current), [true, false, false])
    same(versions.map((version) => version.actor), [ACTOR, AGENT, ACTOR])
    same(versions.map((version) => version.context), [undefined, 'orbit:card/board/1', undefined])
    same(versions.map((version) => version.path), ['dir/doc.md', 'dir/doc.md', 'dir/doc.md'])
    assert.equal(new Set(versions.map((version) => version.version)).size, 3, 'each version has a string of its own')
    for (const version of versions) assert.match(version.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    assert.ok(versions.every((version, index) => index === 0 || Date.parse(versions[index - 1].at) >= Date.parse(version.at)), 'newest first')
    assert.equal(versions[0].version, (await backend.stat(id, 'dir/doc.md')).version, 'the current version is the file’s')
    await refusedWith(backend.versions(id, 'never-written.md'), 'not-found')
    await refusedWith(backend.versions(id, 'dir'), 'type')
  }, { needs: 'versions' })

  add('versions pages with limit and before, so every version is listed once and the last page ends', async (backend, project) => {
    const id = await project()
    for (let count = 1; count <= 7; count += 1) await put(backend, id, 'n.md', `revision ${count}`)
    const seen = (await allVersions(backend, id, 'n.md', 3)).map((version) => version.version)
    assert.equal(seen.length, 7)
    assert.equal(new Set(seen).size, 7, 'no version twice')
    same(seen, (await backend.versions(id, 'n.md', { limit: 50 })).versions.map((version) => version.version))
    assert.equal((await backend.versions(id, 'n.md', { limit: 50 })).next, null)
    assert.equal((await backend.versions(id, 'n.md', { limit: 3 })).versions.length, 3)
  }, { needs: 'versions' })

  add('a file’s versions follow it through a rename, with the path each had then, and a deleted file’s are found by its last path', async (backend, project) => {
    const id = await project()
    await put(backend, id, 'old/note.md', 'one')
    await put(backend, id, 'old/note.md', 'two')
    await backend.rename(id, 'old', 'new')
    await put(backend, id, 'new/note.md', 'three')
    same((await allVersions(backend, id, 'new/note.md')).map((version) => version.path), ['new/note.md', 'old/note.md', 'old/note.md'])
    await put(backend, id, 'gone.md', 'first')
    await put(backend, id, 'gone.md', 'second')
    await backend.remove(id, 'gone.md')
    const deleted = await allVersions(backend, id, 'gone.md')
    assert.equal(deleted.length, 2)
    assert.ok(deleted.every((version) => version.current === false), 'a deleted file has no current version')
    const newest = await backend.readVersion(id, 'gone.md', deleted[0].version)
    assert.equal(decoder.decode(await collect(newest.body)), 'second')
  }, { needs: 'versions' })

  add('readVersion gives a version’s bytes whole, and is not-found for a version that isn’t the file’s', async (backend, project) => {
    const id = await project()
    const bytes = new Uint8Array(70_000)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 7 + (index >> 8)) % 256
    await put(backend, id, 'a.bin', bytes)
    await put(backend, id, 'a.bin', 'later')
    await put(backend, id, 'b.md', 'b one')
    await put(backend, id, 'b.md', 'b two')
    const [, old] = (await backend.versions(id, 'a.bin')).versions
    const read = await backend.readVersion(id, 'a.bin', old.version)
    assert.equal(read.size, bytes.length)
    assert.deepEqual(Array.from(await collect(read.body)), Array.from(bytes))
    const [current] = (await backend.versions(id, 'a.bin')).versions
    assert.equal(decoder.decode(await collect((await backend.readVersion(id, 'a.bin', current.version)).body)), 'later')
    const [, other] = (await backend.versions(id, 'b.md')).versions
    await refusedWith(backend.readVersion(id, 'a.bin', other.version), 'not-found')
    await refusedWith(backend.readVersion(id, 'a.bin', 'no-such:99'), 'not-found')
  }, { needs: 'versions' })

  add('restore brings a version back as the newest: the same bytes, logged as a write by the restorer with restoredFrom, heard on the feed, and the version it replaced still reads', async (backend, project) => {
    const id = await project()
    await put(backend, id, 'doc.md', 'the first words', { actor: ACTOR })
    const second = await put(backend, id, 'doc.md', 'second', { actor: ACTOR })
    const [, first] = (await backend.versions(id, 'doc.md')).versions
    const heard = []
    const stop = await backend.subscribe(id, { change: (record) => heard.push(record), end() {} })
    const start = await backend.cursor(id)
    const restored = await backend.restore(id, 'doc.md', first.version, { actor: AGENT, ifMatch: second.version })
    assert.equal(await textOf(backend, id, 'doc.md'), 'the first words')
    assert.equal(restored.entry.path, 'doc.md')
    assert.equal(restored.version, (await backend.stat(id, 'doc.md')).version)
    assert.notEqual(restored.version, second.version, 'a new revision')
    assert.notEqual(restored.cursor, start)
    const [record] = await recordsSince(backend, id, start)
    assert.equal(record.type, 'write')
    assert.equal(record.path, 'doc.md')
    assert.equal(record.restoredFrom, first.version)
    same(record.actor, AGENT)
    await until(() => heard.length >= 1, 'the feed to hear the restore')
    assert.equal(heard[0].restoredFrom, first.version)
    stop()
    same((await backend.stat(id, 'doc.md')).entry.modifiedBy, AGENT)
    const history = await backend.versions(id, 'doc.md')
    assert.equal(history.versions[0].current, true)
    assert.equal(history.versions[0].restoredFrom, first.version)
    assert.equal(decoder.decode(await collect((await backend.readVersion(id, 'doc.md', second.version)).body)), 'second', 'the version it replaced stays')
  }, { needs: 'versions' })

  add('restore names what it replaces: a stale ifMatch and ifAbsent over a file are 412, nothing changes, bytes equal to the file’s now record nothing, and ifAbsent brings a deleted file back', async (backend, project) => {
    const id = await project()
    const one = await put(backend, id, 'n.md', 'one')
    const two = await put(backend, id, 'n.md', 'two')
    const three = await put(backend, id, 'n.md', 'one')
    const cursor = await backend.cursor(id)
    await refusedWith(backend.restore(id, 'n.md', two.version, { ifMatch: one.version }), 'precondition')
    await refusedWith(backend.restore(id, 'n.md', two.version, { ifMatch: two.version }), 'precondition')
    await refusedWith(backend.restore(id, 'n.md', two.version, { ifAbsent: true }), 'precondition', { exists: true })
    assert.equal(await textOf(backend, id, 'n.md'), 'one')
    assert.equal(await backend.cursor(id), cursor, 'a refused restore changes nothing')
    // The first version holds the bytes the file holds now: nothing to record.
    const identical = await backend.restore(id, 'n.md', one.version, { ifMatch: three.version })
    assert.equal(identical.version, three.version)
    assert.equal(await backend.cursor(id), cursor)
    // A deleted file comes back where it was, when the restorer says nothing is there.
    await backend.remove(id, 'n.md')
    await refusedWith(backend.restore(id, 'n.md', two.version, { ifMatch: three.version }), 'precondition', { absent: true })
    const back = await backend.restore(id, 'n.md', two.version, { ifAbsent: true })
    assert.equal(back.entry.path, 'n.md')
    assert.equal(await textOf(backend, id, 'n.md'), 'two')
    // A version of another file isn't this one's.
    await put(backend, id, 'other.md', 'other')
    const [theirs] = (await backend.versions(id, 'other.md')).versions
    await refusedWith(backend.restore(id, 'n.md', theirs.version, { ifMatch: back.version }), 'not-found')
  }, { needs: 'versions' })

  add('a save of the bytes the file already holds stores nothing: the same version and cursor, no record, no one told, and a stale ifMatch is still refused', async (backend, project) => {
    const id = await project()
    const first = await put(backend, id, 'note.md', 'the same words', { actor: ACTOR })
    const heard = []
    const stop = await backend.subscribe(id, { change: (record) => heard.push(record), end() {} })
    const cursor = await backend.cursor(id)
    const again = await put(backend, id, 'note.md', 'the same words', { actor: AGENT })
    assert.equal(again.version, first.version)
    assert.equal(again.cursor, cursor)
    assert.equal(await backend.cursor(id), cursor)
    same(await recordsSince(backend, id, cursor), [])
    await pause(100)
    same(heard, [])
    stop()
    same((await backend.stat(id, 'note.md')).entry.modifiedBy, ACTOR, 'nobody changed it')
    assert.equal((await backend.versions(id, 'note.md')).versions.length, 1)
    const second = await put(backend, id, 'note.md', 'other words')
    await refusedWith(put(backend, id, 'note.md', 'other words', { ifMatch: first.version }), 'precondition')
    assert.notEqual(second.version, first.version)
  }, { needs: 'versions' })

  add('thinning keeps what the contract says after a sweep: the current version, the version before another actor’s save, the one a remove let go and the one a restore replaced, and every version listed reads back', async (backend, project) => {
    if (typeof backend.sweep !== 'function') return // history without a sweep: nothing thins
    const id = await project()
    const start = await backend.cursor(id)
    // Before another actor's save, and the newest.
    const a1 = await put(backend, id, 'actors.md', 'a one', { actor: ACTOR })
    const a2 = await put(backend, id, 'actors.md', 'a two', { actor: AGENT })
    const a3 = await put(backend, id, 'actors.md', 'a three', { actor: ACTOR })
    // What a remove let go.
    await put(backend, id, 'removed.md', 'r one', { actor: ACTOR })
    const r2 = await put(backend, id, 'removed.md', 'r two', { actor: ACTOR })
    await backend.remove(id, 'removed.md', { actor: ACTOR })
    // What a restore replaced.
    await put(backend, id, 'restored.md', 's one', { actor: ACTOR })
    const s2 = await put(backend, id, 'restored.md', 's two', { actor: ACTOR })
    const [, sOld] = (await backend.versions(id, 'restored.md')).versions
    await backend.restore(id, 'restored.md', sOld.version, { actor: ACTOR, ifMatch: s2.version })
    // Three saves by one actor, in one breath: thinning may drop the older two, and a version it drops is not-found.
    for (const text of ['busy one', 'busy two', 'busy three']) await put(backend, id, 'busy.md', text, { actor: ACTOR })
    const listedBefore = (await allVersions(backend, id, 'busy.md')).map((version) => version.version)
    const before = (await recordsSince(backend, id, start)).length
    await backend.sweep()
    const listedAfter = (await allVersions(backend, id, 'busy.md')).map((version) => version.version)
    for (const version of listedBefore.filter((each) => !listedAfter.includes(each))) await refusedWith(backend.readVersion(id, 'busy.md', version), 'not-found')
    const kept = async (path) => (await allVersions(backend, id, path)).map((version) => version.version)
    const actors = await kept('actors.md')
    assert.equal(actors[0], a3.version, 'the current version')
    for (const version of [a3, a2, a1]) assert.ok(actors.includes(version.version), 'the version before another actor’s save, and the one after it')
    assert.ok((await kept('removed.md')).includes(r2.version), 'the version a remove let go')
    assert.ok((await kept('restored.md')).includes(s2.version), 'the version a restore replaced')
    for (const path of ['actors.md', 'removed.md', 'restored.md']) {
      for (const version of await allVersions(backend, id, path)) await backend.readVersion(id, path, version.version)
    }
    assert.equal(decoder.decode(await collect((await backend.read(id, 'actors.md')).body)), 'a three')
    assert.equal((await recordsSince(backend, id, start)).length, before, 'every change stays in the log')
  }, { needs: 'versions' })

  // --- removed projects (capabilities.removeProject) --------------------------------------------

  add('removeProject takes the project out of every answer and its feeds, ends them after a remove of the root, keeps its id taken and stops counting its files', async (backend, project) => {
    const keep = await project()
    const gone = await project()
    await put(backend, gone, 'n.md', 'x'.repeat(50))
    await put(backend, keep, 'n.md', 'y'.repeat(30))
    const before = await backend.usage()
    const own = await backend.usage(gone)
    const heard = []
    let ended = 0
    await backend.subscribe(gone, { change: (record) => heard.push(record), end: () => (ended += 1) })
    const removed = await backend.removeProject(gone, { actor: AGENT })
    assert.equal(removed.id, gone)
    assert.match(removed.removed, /^\d{4}-\d\d-\d\dT/)
    assert.match(removed.purgeAfter, /^\d{4}-\d\d-\d\dT/)
    assert.ok(Date.parse(removed.purgeAfter) > Date.parse(removed.removed), 'it can come back until then')
    same(removed.removedBy, AGENT)
    await until(() => ended === 1, 'the feed to end')
    assert.deepEqual(heard.map((record) => [record.type, record.path]), [['remove', '']], 'told the root was removed, before the feed ended')
    assert.ok(!(await backend.listProjects()).some((each) => each.id === gone))
    for (const call of [() => backend.project(gone), () => backend.cursor(gone), () => backend.list(gone), () => backend.read(gone, 'n.md'), () => backend.subscribe(gone, { change() {}, end() {} }), () => put(backend, gone, 'm.md', 'x')]) {
      await refusedWith(call(), 'no-project')
    }
    const after = await backend.usage()
    assert.equal(before.bytes - after.bytes, own.bytes, 'its files stop counting at once')
    assert.equal(before.files - after.files, own.files)
    assert.equal(Object.hasOwn(await backend.project(keep), 'id'), true, 'the others are untouched')
    if (backend.capabilities?.createProject === true) await refusedWith(backend.createProject({ id: gone, name: 'Again' }), 'exists')
    const listed = (await backend.removedProjects()).find((each) => each.id === gone)
    assert.ok(listed, 'removedProjects lists it')
    assert.equal(listed.removed, removed.removed)
    assert.equal(listed.purgeAfter, removed.purgeAfter)
    same(listed.removedBy, AGENT)
    assert.ok(!(await backend.removedProjects()).some((each) => each.id === keep))
    await refusedWith(backend.removeProject(gone), 'no-project')
    await refusedWith(backend.removeProject('never-was-a-project'), 'no-project')
  }, { needs: 'removeProject' })

  add('restoreProject brings a removed project back whole, with a new epoch and a mkdir of the root in the log, and refuses one that isn’t removed', async (backend, project) => {
    const id = await project()
    await put(backend, id, 'dir/n.md', 'hello')
    const entries = await backend.list(id)
    const usage = await backend.usage(id)
    const oldCursor = await backend.cursor(id)
    await backend.removeProject(id, { actor: ACTOR })
    const back = await backend.restoreProject(id, { actor: AGENT })
    assert.equal(back.id, id)
    same(await backend.list(id), entries)
    assert.equal(await textOf(backend, id, 'dir/n.md'), 'hello')
    same(await backend.usage(id), usage)
    assert.ok((await backend.listProjects()).some((each) => each.id === id))
    assert.ok(!(await backend.removedProjects()).some((each) => each.id === id))
    assert.equal((await backend.changesSince(id, oldCursor)).resync, true, 'a cursor from before the removal lists again')
    const [last, before] = (await backend.recent({ project: id, limit: 2 })).changes
    assert.deepEqual([last.type, last.path], ['mkdir', ''])
    same(last.actor, AGENT)
    assert.deepEqual([before.type, before.path], ['remove', ''])
    await refusedWith(backend.restoreProject(id), 'no-project')
    await refusedWith(backend.restoreProject('never-was-a-project'), 'no-project')
  }, { needs: 'removeProject' })

  return cases
}

/**
 * Registers the backend cases with a runner's own `describe` and `it`.
 * @param {{ describe: (title: string, body: () => void) => unknown, it: (name: string, run: () => Promise<void>) => unknown }} runner
 * @param {string} title
 * @param {() => unknown} makeBackend  a backend, or `{ backend, newProject?, dispose? }`, new on each call
 */
export function register({ describe, it }, title, makeBackend) {
  describe(title, () => {
    for (const { name, run } of backendCases(makeBackend)) it(name, run)
  })
}
