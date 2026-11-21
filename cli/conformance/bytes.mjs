// The byte store's rules as cases any runner can run: the folder store here, and the Suite's
// bucket store, are held to the same ones (cli/bytes/store.mjs has them in its header). Node
// built-ins only, and no test framework: `byteStoreCases` gives `{ name, run }` pairs, and
// `register` hands them to whatever `describe` and `it` a runner has (vitest, node:test).
//
//   import { register } from '@starlove/nebula/conformance/bytes'
//   register({ describe, it }, 'my bucket store', () => makeMyStore())
//
// `makeStore` is called once per case, so no case depends on another, and answers a store, or
// `{ store, dispose }` where something must be cleaned up after the case (a scratch folder, a
// bucket prefix). Give each call its own empty store, or a prefix of its own in a shared one.
// `list()` is read as the whole store, so cases that count objects need a store nothing else writes.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const OBJECT_ID = /^[a-z2-7]{26}$/

/** The store a call to `makeStore` made, and what to do when the case is done. */
async function open(makeStore) {
  const made = await makeStore()
  if (typeof made?.put === 'function') return { store: made, dispose: async () => void (await made.close?.()) }
  assert.equal(typeof made?.store?.put, 'function', 'makeStore answers a byte store, or { store, dispose }')
  return {
    store: made.store,
    dispose: async () => {
      await made.store.close?.()
      await made.dispose?.()
    },
  }
}

/** Some bytes that say where they are: a different value every 251 bytes, so a swapped or cut chunk shows. */
function bytesOf(length, seed = 0) {
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 7 + Math.floor(index / 251) + seed) % 256
  return bytes
}

/** The bytes as a body of chunks of the given sizes (the last one takes what is left). */
async function* chunked(bytes, size) {
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

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function listed(store) {
  const objects = []
  for await (const object of store.list()) objects.push(object)
  return objects
}

/** Rejects with a code (a BackendError's, or the store's own `no-object`). */
async function refusedWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code, `rejected with ${error?.code ?? error}, not ${code}`)
    return true
  })
}

/** The cases, each `{ name, run }`; `run` throws when the store breaks a rule. */
export function byteStoreCases(makeStore) {
  const cases = []
  const add = (name, body) =>
    cases.push({
      name,
      async run() {
        const { store, dispose } = await open(makeStore)
        try {
          await body(store)
        } finally {
          await dispose()
        }
      },
    })

  // --- put -------------------------------------------------------------------------------------

  add('put answers the exact size and sha256 of the bytes it was given', async (store) => {
    const bytes = bytesOf(150_000)
    const put = await store.put(chunked(bytes, 7_001))
    assert.equal(put.size, bytes.byteLength)
    assert.equal(put.sha256, sha256(bytes))
    assert.equal(typeof put.id, 'string')
  })

  add('put keeps an empty body: size 0, the sha256 of nothing, and an object that reads back empty', async (store) => {
    const put = await store.put(chunked(new Uint8Array(0), 1))
    assert.equal(put.size, 0)
    assert.equal(put.sha256, sha256(new Uint8Array(0)))
    assert.equal((await collect(await store.get(put.id))).byteLength, 0)
  })

  add('put reads its body once, in order, whatever the chunk sizes (one byte at a time, or one chunk)', async (store) => {
    const bytes = bytesOf(3_000, 3)
    for (const size of [1, 999, bytes.byteLength]) {
      const put = await store.put(chunked(bytes, size))
      assert.equal(put.sha256, sha256(bytes), `chunks of ${size}`)
      assert.deepEqual(await collect(await store.get(put.id)), bytes, `chunks of ${size}`)
    }
  })

  add('put has the bytes by the time it resolves: they read back whole, and list shows the object', async (store) => {
    const bytes = bytesOf(40_000, 9)
    const put = await store.put(chunked(bytes, 4_096))
    assert.deepEqual(await collect(await store.get(put.id)), bytes)
    assert.ok((await listed(store)).some((object) => object.id === put.id), 'the object is listed')
  })

  add('put takes the bytes as given, even when the sender reuses one buffer for every chunk', async (store) => {
    const expected = bytesOf(5 * 1_000, 17)
    async function* reusing() {
      const buffer = new Uint8Array(1_000)
      for (let at = 0; at < expected.byteLength; at += buffer.byteLength) {
        buffer.set(expected.subarray(at, at + buffer.byteLength))
        yield buffer
      }
    }
    const put = await store.put(reusing())
    assert.equal(put.sha256, sha256(expected))
    assert.deepEqual(await collect(await store.get(put.id)), expected)
  })

  add('put past maxBytes rejects with too-large, stops reading and keeps nothing', async (store) => {
    const before = (await listed(store)).length
    let pulled = 0
    // Long enough to show a store that ignores the cap, and not endless, so such a store fails here and doesn't hang.
    async function* endless() {
      for (let chunk = 0; chunk < 200; chunk += 1) {
        pulled += 1
        yield new Uint8Array(1_024)
      }
    }
    await refusedWith(store.put(endless(), { maxBytes: 4_096 }), 'too-large')
    // 4 chunks fit; the fifth passes the cap. A store may have read one chunk ahead of its writes.
    assert.ok(pulled <= 6, `read ${pulled} chunks of a body that passed the cap at 5`)
    assert.equal((await listed(store)).length, before, 'no object is left behind')
  })

  add('put of exactly maxBytes is kept; one byte more is too-large', async (store) => {
    const exact = bytesOf(2_048, 5)
    const put = await store.put(chunked(exact, 500), { maxBytes: exact.byteLength })
    assert.equal(put.size, exact.byteLength)
    const before = (await listed(store)).length
    await refusedWith(store.put(chunked(bytesOf(2_049), 500), { maxBytes: 2_048 }), 'too-large')
    assert.equal((await listed(store)).length, before)
  })

  add('put whose body fails rejects with that failure, and the store carries on', async (store) => {
    const boom = new Error('the sender went away')
    async function* failing() {
      yield bytesOf(10_000)
      throw boom
    }
    await assert.rejects(store.put(failing()), (error) => error === boom || error?.cause === boom || error?.message === boom.message)
    // Whatever such a put leaves is something nothing names (the sweep takes it); the store still works.
    const bytes = bytesOf(100, 2)
    const put = await store.put(chunked(bytes, 100))
    assert.deepEqual(await collect(await store.get(put.id)), bytes)
  })

  // --- ids -------------------------------------------------------------------------------------

  add('ids are the store’s own, shaped as OBJECT_ID, and differ even for identical bytes', async (store) => {
    const bytes = bytesOf(64)
    const ids = new Set()
    for (let count = 0; count < 20; count += 1) {
      const { id } = await store.put(chunked(bytes, 64))
      assert.match(id, OBJECT_ID)
      ids.add(id)
    }
    assert.equal(ids.size, 20)
  })

  add('ids put at the same moment never collide, and each holds its own bytes', async (store) => {
    const bodies = Array.from({ length: 12 }, (_, index) => bytesOf(2_000 + index, index))
    const puts = await Promise.all(bodies.map((bytes) => store.put(chunked(bytes, 333))))
    assert.equal(new Set(puts.map((put) => put.id)).size, bodies.length)
    for (const [index, put] of puts.entries()) {
      assert.equal(put.sha256, sha256(bodies[index]))
      assert.deepEqual(await collect(await store.get(put.id)), bodies[index])
    }
  })

  add('an id is never reused, not even after its object is deleted', async (store) => {
    const seen = new Set()
    const first = await store.put(chunked(bytesOf(10), 10))
    seen.add(first.id)
    await store.delete(first.id)
    for (let count = 0; count < 25; count += 1) {
      const { id } = await store.put(chunked(bytesOf(10), 10))
      assert.ok(!seen.has(id), 'an id came back')
      seen.add(id)
    }
  })

  // --- get -------------------------------------------------------------------------------------

  add('get gives the same bytes every time, also read side by side', async (store) => {
    const bytes = bytesOf(200_000, 11)
    const { id } = await store.put(chunked(bytes, 16_384))
    assert.deepEqual(await collect(await store.get(id)), bytes)
    assert.deepEqual(await collect(await store.get(id)), bytes)
    const [a, b] = await Promise.all([store.get(id), store.get(id)])
    const [one, two] = await Promise.all([collect(a), collect(b)])
    assert.deepEqual(one, bytes)
    assert.deepEqual(two, bytes)
  })

  add('get of an object another put or delete touched is unchanged: objects never change', async (store) => {
    const bytes = bytesOf(1_000, 4)
    const { id } = await store.put(chunked(bytes, 100))
    const other = await store.put(chunked(bytesOf(1_000, 5), 100))
    await store.delete(other.id)
    assert.deepEqual(await collect(await store.get(id)), bytes)
  })

  add('get can be stopped part-way, and the object reads whole afterwards', async (store) => {
    const bytes = bytesOf(300_000, 6)
    const { id } = await store.put(chunked(bytes, 32_768))
    const stream = await store.get(id)
    const reader = stream.getReader()
    await reader.read()
    await reader.cancel()
    assert.deepEqual(await collect(await store.get(id)), bytes)
  })

  add('get of an id the store never made rejects with no-object', async (store) => {
    await refusedWith(store.get('a'.repeat(26)), 'no-object')
  })

  add('get of something that isn’t an id rejects with no-object, and reaches nothing', async (store) => {
    for (const id of ['', '../etc/passwd', 'ab/cd/abcdefghijklmnopqrstuvwxyz', 'A'.repeat(26), 'a'.repeat(25), 'a'.repeat(27), `${'a'.repeat(25)}\u0000`, 'a'.repeat(24) + '18']) {
      await refusedWith(store.get(id), 'no-object')
    }
  })

  // --- delete ----------------------------------------------------------------------------------

  add('delete removes one object, and only that one', async (store) => {
    const keep = bytesOf(500, 1)
    const kept = await store.put(chunked(keep, 100))
    const gone = await store.put(chunked(bytesOf(500, 2), 100))
    await store.delete(gone.id)
    await refusedWith(store.get(gone.id), 'no-object')
    assert.deepEqual(await collect(await store.get(kept.id)), keep)
    const ids = (await listed(store)).map((object) => object.id)
    assert.ok(!ids.includes(gone.id))
    assert.ok(ids.includes(kept.id))
  })

  add('delete resolves whether or not the object was there, and for what isn’t an id', async (store) => {
    const { id } = await store.put(chunked(bytesOf(10), 10))
    await store.delete(id)
    await store.delete(id)
    await store.delete('a'.repeat(26))
    for (const bad of ['', '../x', 'nope']) await store.delete(bad)
  })

  // --- list ------------------------------------------------------------------------------------

  add('list reports every object once, with its size and when it was put, no later than put resolving', async (store) => {
    const puts = []
    for (let count = 0; count < 30; count += 1) {
      const before = Date.now()
      const bytes = bytesOf(100 + count * 13, count)
      const put = await store.put(chunked(bytes, 64))
      puts.push({ ...put, before, after: Date.now() })
    }
    const objects = await listed(store)
    assert.equal(objects.length, puts.length, 'every object, none twice')
    assert.equal(new Set(objects.map((object) => object.id)).size, puts.length)
    for (const put of puts) {
      const object = objects.find((each) => each.id === put.id)
      assert.ok(object, `${put.id} is listed`)
      assert.match(object.id, OBJECT_ID)
      // A sealed object may be larger than its file; it is never smaller.
      assert.ok(Number.isFinite(object.size) && object.size >= put.size, `size ${object.size} for a file of ${put.size}`)
      assert.ok(Number.isFinite(object.at), 'at is a number of milliseconds')
      assert.ok(object.at <= put.after, `at ${object.at} is after put resolved at ${put.after}`)
      // Milliseconds, not seconds, and not the epoch: the sweep's grace is measured from it.
      assert.ok(object.at >= put.before - 60_000, `at ${object.at} is long before the put began at ${put.before}`)
    }
  })

  add('list of an empty store is empty, and never shows a put that was refused', async (store) => {
    assert.deepEqual(await listed(store), [])
    await refusedWith(store.put(chunked(bytesOf(100), 10), { maxBytes: 10 }), 'too-large')
    assert.deepEqual(await listed(store), [])
  })

  return cases
}

/**
 * Registers the byte store cases with a runner's own `describe` and `it`.
 * @param {{ describe: (title: string, body: () => void) => unknown, it: (name: string, run: () => Promise<void>) => unknown }} runner
 * @param {string} title
 * @param {() => unknown} makeStore  a store or `{ store, dispose }`, new on each call
 */
export function register({ describe, it }, title, makeStore) {
  describe(title, () => {
    for (const { name, run } of byteStoreCases(makeStore)) it(name, run)
  })
}
