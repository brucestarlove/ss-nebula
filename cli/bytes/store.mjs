// The byte store: where the database backend (cli/backends/database.mjs) keeps each file's bytes,
// one object per version of a file. An object is put once, under a random id that says nothing about
// the file, and never changes after; the database names it. A folder here (cli/bytes/folder.mjs),
// and in the Suite a bucket (starscape-suite-files), sealed with the workspace's key, behind the
// same interface. Node built-ins only, like the rest of cli/.
//
// What any byte store must keep, the Suite's bucket store included:
// - `put` answers `{ id, size, sha256 }` of exactly the bytes it was given, and only once they are
//   durable: the database commits the entry that names the object after `put` resolves, so a
//   committed entry always has its bytes. On any failure (`too-large`, a full disk, a stream that
//   errors) it leaves no object behind, or one nothing will ever name (the sweep takes it).
// - An id is made by the store, random, and never reused, so an object is never written twice and
//   a reader holding an id always gets the same bytes. A bucket writes it with `If-None-Match: *`
//   where the provider honours that, and otherwise relies on the id's 128 random bits.
// - `get(id)` returns the object's bytes whole, by id alone. A sealed store unseals them here; a
//   later `range` option reads part of one (a video scrubbed), which is why the Suite seals in
//   fixed segments.
// - `delete(id)` removes one object and resolves whether or not it was there. Only the sweep calls it.
// - `list()` reports every object with when it was put, for the sweep. No order is assumed (a
//   bucket lists in pages, by key), and an object put while the list runs may or may not appear.
//   `at` must not be later than the moment `put` resolved, or the sweep's grace is shortened.

/**
 * @typedef {object} PutResult
 * @property {string} id  the object's id: the store's own, random, never reused
 * @property {number} size  bytes
 * @property {string} sha256  lower-case hex of the bytes as given (before any sealing)
 */

/**
 * @typedef {object} StoredObject
 * @property {string} id
 * @property {number} size  as stored (a sealed object may be larger than the file)
 * @property {number} at  when it was put, in milliseconds: its age is `now - at`
 */

/**
 * The interface.
 * @typedef {object} ByteStore
 * @property {(body: AsyncIterable<Uint8Array>, options?: { maxBytes?: number }) => Promise<PutResult>} put  rejects with `BackendError('too-large')` once the body passes `maxBytes`, having stopped reading and kept nothing; `disk-full` when the store is full
 * @property {(id: string) => Promise<ReadableStream<Uint8Array>>} get  the object's bytes; rejects with code `no-object` when it isn't there
 * @property {(id: string) => Promise<void>} delete
 * @property {() => AsyncIterable<StoredObject>} list
 * @property {() => void | Promise<void>} [close]
 */

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** An object id: 16 random bytes as 26 characters of RFC 4648 base32, in lower case, unpadded. */
export function newObjectId(randomBytes) {
  const bytes = randomBytes(16)
  let bits = 0
  let value = 0
  let id = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      id += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) id += BASE32[(value << (5 - bits)) & 31]
  return id
}

/** What an object id looks like: checked before an id becomes part of a path or a key. */
export const OBJECT_ID = /^[a-z2-7]{26}$/

/** The error a store gives for an id it doesn't hold: the server's fault when a committed entry names it. */
export class MissingObjectError extends Error {
  constructor(id) {
    super(`No object ${JSON.stringify(id)} in the byte store`)
    this.name = 'MissingObjectError'
    this.code = 'no-object'
  }
}
