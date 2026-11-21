// The byte store in a folder (cli/bytes/store.mjs has the interface): each object a file named by
// its id in sharded folders, `ab/cd/<id>`, so no folder grows past a few thousand names. A put
// streams into a temporary file in `tmp/`, syncs it, links it into place (which refuses an existing
// name, so an object is never written twice) and syncs the folder it landed in, so an object exists
// whole or not at all after a crash. Node built-ins only.
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { createReadStream, constants as FS } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { BackendError } from '../backend.mjs'
import { MissingObjectError, OBJECT_ID, newObjectId } from './store.mjs'

/** What link(2) says on a disk that has no hard links (as in cli/backends/folder.mjs). */
const NO_LINK = new Set(['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL'])
const ON_WINDOWS = process.platform === 'win32'
const TEMPORARY = /^\.put-[0-9a-f]{16}$/

function diskProblem(error) {
  if (error?.code === 'ENOSPC' || error?.code === 'EDQUOT') return new BackendError('disk-full', "The disk is full, so that couldn't be saved")
  if (error?.code === 'EROFS') return new BackendError('read-only', 'The byte store is on a read-only disk')
  return null
}

/** Syncs a folder, so a name just made or removed in it survives a crash. Windows can't open a
 * folder for that, and its file system orders the name with the data anyway. */
async function syncFolder(path) {
  if (ON_WINDOWS) return
  const handle = await open(path, FS.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * A byte store over a folder of its own (made when missing). Nothing else should write there.
 * @returns {import('./store.mjs').ByteStore & { root: string, cleanTemporary: (olderThanMs: number, now?: number) => Promise<number> }}
 */
export function createFolderByteStore({ root }) {
  const temporaryDir = join(root, 'tmp')
  const objectsDir = join(root, 'objects')
  let made = null
  const ready = () => (made ??= Promise.all([mkdir(temporaryDir, { recursive: true }), mkdir(objectsDir, { recursive: true })]))

  const shardOf = (id) => join(objectsDir, id.slice(0, 2), id.slice(2, 4))
  const pathOf = (id) => join(shardOf(id), id)

  /** Makes the object's shard folders, syncing each parent a folder was made in. */
  async function makeShard(id) {
    const first = join(objectsDir, id.slice(0, 2))
    for (const [folder, parent] of [[first, objectsDir], [shardOf(id), first]]) {
      try {
        await mkdir(folder)
        await syncFolder(parent)
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
    }
  }

  /** Puts the temporary file at the object's name, refusing a name that is taken. */
  async function place(temp, target) {
    try {
      await link(temp, target)
      return
    } catch (error) {
      if (!NO_LINK.has(error.code)) throw error
    }
    // No hard links on this disk: take the name by an exclusive create, then rename over that
    // empty file of our own.
    const handle = await open(target, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o644)
    await handle.close()
    await rename(temp, target)
  }

  async function put(body, { maxBytes = Infinity } = {}) {
    await ready()
    const temp = join(temporaryDir, `.put-${randomBytes(8).toString('hex')}`)
    const hash = createHash('sha256')
    let size = 0
    let handle
    try {
      handle = await open(temp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o644)
      for await (const chunk of body) {
        size += chunk.byteLength
        // Counted before it is written: past the cap nothing more is read or kept.
        if (size > maxBytes) throw new BackendError('too-large', `The file is over ${maxBytes} bytes`)
        hash.update(chunk)
        await handle.write(chunk)
      }
      await handle.sync()
      await handle.close()
      handle = null
      // A random id is never taken; the loop is for the case it is, so nothing is written twice.
      for (;;) {
        const id = newObjectId(randomBytes)
        await makeShard(id)
        try {
          await place(temp, pathOf(id))
        } catch (error) {
          if (error.code === 'EEXIST') continue
          throw error
        }
        await syncFolder(shardOf(id))
        return { id, size, sha256: hash.digest('hex') }
      }
    } catch (error) {
      throw diskProblem(error) ?? error
    } finally {
      await handle?.close().catch(() => {})
      await unlink(temp).catch(() => {})
    }
  }

  async function get(id) {
    if (!OBJECT_ID.test(id)) throw new MissingObjectError(id)
    let handle
    try {
      handle = await open(pathOf(id), FS.O_RDONLY | FS.O_NOFOLLOW)
    } catch (error) {
      if (error.code === 'ENOENT') throw new MissingObjectError(id)
      throw error
    }
    // Cancelling the web stream destroys the file stream, which closes the file.
    return Readable.toWeb(createReadStream(null, { fd: handle, autoClose: true }))
  }

  async function remove(id) {
    if (!OBJECT_ID.test(id)) return
    try {
      await unlink(pathOf(id))
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    await syncFolder(shardOf(id)).catch(() => {})
  }

  async function* list() {
    await ready()
    for (const first of await readdir(objectsDir)) {
      if (!/^[a-z2-7]{2}$/.test(first)) continue
      for (const second of await readdir(join(objectsDir, first)).catch(() => [])) {
        if (!/^[a-z2-7]{2}$/.test(second)) continue
        const shard = join(objectsDir, first, second)
        for (const id of await readdir(shard).catch(() => [])) {
          if (!OBJECT_ID.test(id) || id.slice(0, 4) !== first + second) continue
          const st = await lstat(join(shard, id)).catch(() => null)
          // The file's time is when its bytes were last written, just before it was put in place.
          if (st?.isFile()) yield { id, size: st.size, at: st.mtimeMs }
        }
      }
    }
  }

  /** Removes the temporary files a crash left mid-put, older than `olderThanMs`: only names this
   * store makes, in its own `tmp/`. Returns how many went. */
  async function cleanTemporary(olderThanMs, now = Date.now()) {
    await ready()
    let removed = 0
    for (const name of await readdir(temporaryDir)) {
      if (!TEMPORARY.test(name)) continue
      const st = await lstat(join(temporaryDir, name)).catch(() => null)
      if (st?.isFile() && now - st.mtimeMs > olderThanMs) {
        await unlink(join(temporaryDir, name)).catch(() => {})
        removed += 1
      }
    }
    return removed
  }

  return { root, put, get, delete: remove, list, cleanTemporary }
}
