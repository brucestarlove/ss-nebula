// Nebula's server tier: projects served to the Nebula app on the same origin, through one HTTP API
// over a backend (cli/backend.mjs): real folders by default (cli/backends/folder.mjs). Node built-ins only.
//
//   GET    <api>/place                              where this is (its homes, scope, capabilities), and its projects
//   POST   <api>/projects                           a new project, { name, color? }, where the backend makes them
//   GET    <api>/projects/<id>/state                the project's change cursor
//   GET    <api>/projects/<id>/list                 every file and folder
//   GET    <api>/projects/<id>/stat?path=           one entry, or 404
//   GET    <api>/projects/<id>/file?path=           a file's bytes, with its ETag
//   PUT    <api>/projects/<id>/file?path=           replace whole (If-Match, If-None-Match: *)
//   POST   <api>/projects/<id>/mkdir?path=
//   POST   <api>/projects/<id>/rename?from=&to=     refuses an existing target
//   DELETE <api>/projects/<id>/file?path=           a file, or a folder and all in it
//   GET    <api>/projects/<id>/events?since=        Server-Sent Events, resumable
//   GET    <api>/projects/<id>/versions?path=&limit=&before=   a file's kept versions, newest first
//   GET    <api>/projects/<id>/version?path=&version=   one version's bytes
//   POST   <api>/projects/<id>/restore?path=&version=   that version back as the newest (If-Match, If-None-Match: *)
//   GET    <api>/projects/<id>/deleted?limit=       the files deleted and still restorable, newest first
//   DELETE <api>/projects/<id>                      remove the project, restorable for 14 days
//   GET    <api>/removed-projects                   the projects removed and not yet purged
//   POST   <api>/removed-projects/<id>/restore      one of them back
//   GET    <api>/changes?project=&path=&limit=&before=   who changed what, when, newest first
//
// History and removed projects answer 405 `not-supported` where the backend can't keep them
// (`capabilities.versions`, `capabilities.removeProject`: the database backend can, folders can't).
//
// `<api>` is `/nebula-api/v1` unless the host mounts it elsewhere (`apiBase`); the Server-Timing mark
// names it, so the app can find it. The API is a web-standard `fetch(request)`, so Hono, Node, Bun
// or Workers can mount it; `handle(req, res)` is the same over Node's http.
//
// Every change records who made it, when and in what context: the actor (`resolve`; on a standalone
// server a person, or an agent that says so with `Nebula-Actor: agent` and `Nebula-Agent-Name`), and
// a link the writer names in `Nebula-Context` (`orbit:card/<board>/<n>`), kept as given and never
// fetched.
//
// A host may set an allowance (`allowance`): a write that would take the workspace past it answers
// 507 `space-full`, and the place says how much is used. A host whose session has ended answers
// with `signedOut()` from its `resolve`. Both are the host's: Nebula stores no account or limit.
//
// It answers only the Host names it serves (loopback, plus --allow-host), refuses cross-site
// requests (Sec-Fetch-Site, Origin) and sends no CORS headers, so a web page elsewhere can't drive
// it through the browser. What a path may be, and what the disk is checked for, is the backend's.
import { hostname } from 'node:os'
import { BackendError, changeOf, isHiddenName, pathProblem } from './backend.mjs'
import { createFolderBackend, isWindowsAlias, probeLink } from './backends/folder.mjs'

export { isHiddenName, isWindowsAlias, pathProblem, probeLink }

export const API = '/nebula-api/v1'

/** The mark a Nebula server puts on its responses, naming where its API is: the app finds the
 * server by the mark's name (src/app/serverTier.ts) without a request. */
export function serverTimingFor(apiBase = API) {
  return `nebula-files;desc="${apiBase}"`
}

export const SERVER_TIMING = serverTimingFor(API)

const CLIENT = /^[A-Za-z0-9_-]{8,64}$/
/** A context is a link's characters (RFC 3986), at most 256 of them: `orbit:card/<board>/<n>`. */
const CONTEXT = /^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]{1,256}$/
const RECENT_LIMIT = 500
const VERSIONS_LIMIT = 200
/** How many deleted files a list holds unless it asks for fewer, and the most it may ask for. */
const DELETED_LIMIT = 200
const DELETED_LIMIT_MAX = 500
/** A page's `next`, or a version, as the server gave it: a link's plain characters. */
const TOKEN = /^[A-Za-z0-9._:-]{1,128}$/
/** A new project's request: its name and colour, never more than this. */
const NEW_PROJECT_MAX = 16 * 1024
const NAME_MAX = 120
const COLOUR = /^#[0-9a-f]{6}$/i
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const ACTOR_TYPES = new Set(['human', 'agent'])
/** Where a project can live in the app this server serves: the browser's own storage, a folder the
 * person picks there, and this server. */
export const HOMES = Object.freeze(['browser', 'folder', 'server'])
/** A host's scope: an opaque id of its choosing (an account), a link's characters. */
const SCOPE = /^[A-Za-z0-9._~:-]{1,128}$/
const encoder = new TextEncoder()

function isLoopbackAddress(address = '') {
  return address === '::1' || /^(::ffff:)?127\./.test(address)
}

/** A version, quoted as an ETag; and back. */
const etagOf = (version) => `"${version}"`
const versionIn = (etag) => (/^".*"$/.test(etag) ? etag.slice(1, -1) : etag)

/** Projects as a client sees them: never the host's path. */
const publicInfo = ({ dir: _dir, ...info }) => info

/** A record as anyone may read it: the asking page's id stays with the feed's echo. */
const publicRecord = ({ client: _client, ...record }) => record

/** A name on one line, at most 80 characters, as Orbit's local mode reads its agent headers. */
/** A host's words for a person: control characters out, spaces folded, at most `limit` long. */
function cleanText(value, limit) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, limit)
}

function cleanName(value, fallback) {
  return cleanText(value, 80) || fallback
}

/** An actor's id from its name, as Orbit makes one: lower case, words joined by '-'. */
function idFromName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'agent'
}

/** The person at a standalone server, as its changes and new projects name them: `createdBy`, or
 * the server's label. A backend made outside createFilesApi (nebula run --database) takes its `id`
 * as `createdBy`, so its projects name the same person the API's records do. */
export function serverPerson({ label = hostname(), createdBy } = {}) {
  const name = cleanName(createdBy ?? label, 'nebula-server')
  return { type: 'human', id: idFromName(name), name }
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  })
}

/** A link a host gives the app to send a person to (sign in, get more space): an https or http
 * address, or a path on the host. Anything else (`javascript:`, `//elsewhere`) is the host's mistake. */
const HOST_LINK = /^(https?:\/\/[^\s]+|\/(?!\/)[^\s]*)$/

function hostLink(value, what) {
  if (typeof value !== 'string' || value.length > 2048 || !HOST_LINK.test(value)) {
    throw new Error(`${what} is an http(s) address or a path on the host, such as /sign-in: ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * The answer for a request whose session has ended: a host's `resolve` returns it. A 401 with
 * `{ error: 'signed-out', message, signIn? }`, which the app reads as "you're signed out" (it keeps
 * the person's unsaved edits and offers `signIn`), never as a failure of the server.
 * @param {{ signIn?: string, message?: string }} [options]  `signIn`: where the person signs in again
 * @returns {Response}
 */
export function signedOut({ signIn, message = 'You’re signed out. Sign in again to keep working.' } = {}) {
  const words = cleanText(message, 300) || 'You’re signed out. Sign in again to keep working.'
  return json(401, { error: 'signed-out', message: words, ...(signIn === undefined ? {} : { signIn: hostLink(signIn, 'signIn') }) })
}

/** Bytes in words: 1.5 MB, 800 KB. */
function sizeWords(bytes) {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  const shown = unit === 0 ? String(value) : value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '')
  return `${shown} ${units[unit]}`
}

/**
 * The file API. `roots` are folders served as one project each; `projectsDirs` are folders whose
 * every (non-hidden) subfolder is a project, looked at again as projects come and go. A host passes
 * its own `backend` and `resolve` instead (the Suite: its database backend, and the signed-in account).
 */
export function createFilesApi({
  roots = [],
  projectsDirs = [],
  label = hostname(),
  allowHosts = [],
  maxBytes = 256 * 1024 * 1024,
  /** Who the person using this server is (a project's createdBy, and the actor of their changes);
   * the server's label when not given. */
  createdBy,
  /** Answer a loopback Host name only from a loopback address (nebula run, Secu S6). Off for a
   * container, whose requests all come through its bridge. Through `fetch`, the host passes the
   * address (`{ remoteAddress }`); without it a loopback name is refused. */
  loopbackPeer = false,
  /** How changes by others are watched: 'folders' (one watcher per served folder, the default on
   * Linux and elsewhere) or 'recursive' (one native watcher, the default on macOS and Windows). */
  watchMode,
  /** The most folders watched in one project, and in all (each costs about 1.2 KB). */
  maxWatched,
  maxWatchedTotal,
  log = () => {},
  /** Where the projects are kept (cli/backend.mjs); folders from `roots` and `projectsDirs` by default. */
  backend,
  /** Where the API answers: no trailing slash. */
  apiBase = API,
  /** Who is asking, checked before every route (after the Host and site guards): `{ actor }`, or a
   * Response that refuses the request. The default is for a standalone server on a trusted machine. */
  resolve,
  /** The homes the app offers a person here (HOMES): every one by default; `['server']` in the
   * Suite, where the browser's storage belongs to the address, not the account. */
  homes = HOMES,
  /** Whose this is, as an opaque id the host chooses (an account): the app keys what it notes on
   * the device about this server's projects by it, so one account's recent projects don't show for
   * another on the same computer. A string, or `(request, actor) => string | undefined` where one
   * handler serves several accounts. */
  scope,
  /** How much the workspace may hold, in bytes: a number, or `(request, actor) => ({ bytes, upgrade? }
   * | number | undefined)` where it differs by account. `upgrade` is where the person can get more
   * space. The whole backend is one workspace (`backend.usage()`: current files only, never the
   * earlier versions kept for history). A write that would take it past the limit answers 507
   * `space-full`; one that doesn't grow it, a remove, a rename and a new folder always pass, so
   * someone who is over can still trim. Without the option nothing is limited and the place says
   * nothing of space. */
  allowance,
} = {}) {
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(apiBase)) throw new Error(`apiBase is a path such as ${API}, with no trailing slash: ${JSON.stringify(apiBase)}`)
  if (!Array.isArray(homes) || !homes.includes('server') || homes.some((home) => !HOMES.includes(home))) {
    throw new Error(`homes lists 'server' and any of ${HOMES.join(', ')}: ${JSON.stringify(homes)}`)
  }
  if (scope !== undefined && typeof scope !== 'function' && !SCOPE.test(scope)) throw new Error(`scope is an opaque id of at most 128 link characters: ${JSON.stringify(scope)}`)
  if (allowance !== undefined && typeof allowance !== 'function' && !(Number.isFinite(allowance) && allowance >= 0)) throw new Error(`allowance is a number of bytes or a function: ${JSON.stringify(allowance)}`)
  const offered = HOMES.filter((home) => homes.includes(home))
  const allowed = new Set(allowHosts.map((host) => host.toLowerCase()))
  /** The person at this server: on a trusted machine, whoever asks without saying they are an agent. */
  const owner = serverPerson({ label, createdBy })
  backend ??= createFolderBackend({ roots, projectsDirs, createdBy: owner.id, watchMode, maxWatched, maxWatchedTotal, log })
  resolve ??= (request) => ({ actor: actorOf((name) => request.headers.get(name)) })
  const serverTiming = serverTimingFor(apiBase)
  /** The projects as last listed, for `projects()`. */
  let known = []

  const isApiPath = (pathname) => pathname === apiBase || pathname.startsWith(`${apiBase}/`)

  async function listProjects(actor = owner) {
    known = await backend.listProjects({ actor })
    return known
  }

  /** Who is asking on a standalone server: an agent when it says so (`Nebula-Actor: agent`, or a
   * `Nebula-Agent-Name`), else the person at this server. A host with accounts reads its
   * credentials instead, and these headers then mean nothing. */
  function actorOf(header) {
    const type = String(header('nebula-actor') ?? '').trim().toLowerCase()
    const agentName = header('nebula-agent-name') ?? ''
    if (type !== 'agent' && !agentName.trim()) return owner
    const name = cleanName(agentName, 'agent')
    return { type: 'agent', id: idFromName(name), name }
  }

  /** The actor a host's resolve gave, as every record holds it; null when it isn't one. */
  function actorIn(actor) {
    if (!actor || !ACTOR_TYPES.has(actor.type) || typeof actor.id !== 'string' || !actor.id || typeof actor.name !== 'string') return null
    return { type: actor.type, id: actor.id.slice(0, 128), name: cleanName(actor.name, actor.id).slice(0, 80) }
  }

  /** The context a writer names, or none; anything that isn't a short link is refused, never stored. */
  function contextOf(value) {
    if (value === null || value === '') return undefined
    if (!CONTEXT.test(value)) throw new BackendError('invalid-context', 'Nebula-Context is a link of at most 256 characters, such as orbit:card/<board>/<n>')
    return value
  }

  /** The body, refused once it passes maxBytes, or `room` (what the allowance leaves: `full` makes the refusal). */
  async function* limited(body, room = Infinity, full) {
    let size = 0
    for await (const chunk of body ?? []) {
      size += chunk.byteLength
      if (size > maxBytes) throw new BackendError('too-large', `The file is over ${maxBytes} bytes`)
      if (size > room) throw full()
      yield chunk
    }
  }

  /** The allowance for this request, `{ limit?, upgrade? }`; `{}` when it has none, null when the
   * host sets no allowance at all (nothing is said of space then). */
  async function allowanceFor(request, actor) {
    if (allowance === undefined) return null
    const given = typeof allowance === 'function' ? await allowance(request, actor) : allowance
    if (given === undefined || given === null) return {}
    const bytes = typeof given === 'number' ? given : given?.bytes
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error(`allowance gave ${JSON.stringify(given)}, not a number of bytes or { bytes, upgrade? }`)
    const upgrade = typeof given === 'object' && given.upgrade !== undefined ? hostLink(given.upgrade, 'allowance’s upgrade') : undefined
    return { limit: Math.floor(bytes), ...(upgrade === undefined ? {} : { upgrade }) }
  }

  /** The workspace's space now: what it holds, and the allowance where there is one; null with no
   * allowance option, or (`limitedOnly`, for a write that has no use for the count otherwise) with
   * no limit for this request. */
  async function spaceFor(request, actor, limitedOnly = false) {
    const set = await allowanceFor(request, actor)
    if (set === null || (limitedOnly && set.limit === undefined)) return null
    return { used: (await backend.usage()).bytes, ...set }
  }

  /**
   * How large a file of this request may be, in bytes, before it takes the workspace past its
   * allowance: Infinity when there is none. `adding` is the size of the file about to be kept (when
   * it's known) and `replacing` the size of the file it replaces, so what counts is the difference:
   * a file no larger than the one it replaces always fits, even when the workspace is over.
   * Refuses with `space-full` (507) when `adding` doesn't fit. A restore passes the old version's
   * size as `adding` and the current file's as `replacing`.
   * @param {Request} request
   * @param {import('./backend.mjs').Actor} actor
   * @param {number} [adding]
   * @param {number} [replacing]
   * @returns {Promise<number>}
   */
  async function roomFor(request, actor, adding, replacing = 0) {
    const space = await spaceFor(request, actor, true)
    if (!space) return Infinity
    const room = roomLeft(space, replacing)
    if (adding !== undefined && adding > room) throw spaceFull(space)
    return room
  }

  /** The largest the new file may be: what the limit leaves, and never less than the file it replaces. */
  const roomLeft = (space, replacing) => Math.max(space.limit - space.used + replacing, replacing)

  /** The 507 for a workspace this full: `used` and `limit` as numbers the app can show. */
  const spaceFull = ({ used, limit, upgrade }) =>
    new BackendError('space-full', `This space is full (${sizeWords(used)} of ${sizeWords(limit)} used), so that couldn’t be saved`, {
      used,
      limit,
      ...(upgrade === undefined ? {} : { upgrade }),
    })

  /** What a PUT may write: the body to give the backend, held to maxBytes and to the allowance. A
   * declared length that wouldn't fit is refused before a byte is read; one of unknown length is
   * read only up to the room left. */
  async function accepted(request, actor, id, path) {
    const space = await spaceFor(request, actor, true)
    if (!space) return limited(request.body)
    // The bytes of the file this one replaces: they're freed as the new ones land.
    const current = await backend.stat(id, path)
    const replacing = current?.entry.type === 'file' ? (current.entry.size ?? 0) : 0
    const room = roomLeft(space, replacing)
    const declared = declaredLength(request.headers.get('content-length'))
    if (declared !== Infinity && declared > room) throw spaceFull(space)
    return limited(request.body, room, () => spaceFull(space))
  }

  /** The project's feed as Server-Sent Events, from `since`: listening first, then reading what was
   * missed, so a change landing between the two is held and told once, after the backlog. */
  function events(request, id, since) {
    let stop = () => {}
    let closed = false
    let ping = null
    const finish = () => {
      if (closed) return
      closed = true
      clearInterval(ping)
      stop()
    }
    const stream = new ReadableStream({
      start(controller) {
        const write = (text) => {
          if (!closed) controller.enqueue(encoder.encode(text))
        }
        // The record whole, beside the two fields clients read: `change`, and `by` (the page that made it).
        const send = (record) => write(`id: ${record.cursor}\nevent: change\ndata: ${JSON.stringify({ ...publicRecord(record), change: changeOf(record), by: record.client ?? null })}\n\n`)
        let held = []
        let last = 0
        const live = (record) => {
          if (held) held.push(record)
          else if (record.seq > last) send(record)
        }
        // The project's feed stopped for good here: end the stream, so the client reconnects and resyncs.
        const end = () => {
          if (closed) return
          finish()
          controller.close()
        }
        write('retry: 2000\n\n')
        ping = setInterval(() => write(': ping\n\n'), 20_000)
        request.signal?.addEventListener('abort', finish, { once: true })
        backend.subscribe(id, { change: live, end }).then(async (unsubscribe) => {
          stop = unsubscribe
          if (closed) return unsubscribe()
          const since_ = await backend.changesSince(id, since)
          last = Number(since_.cursor.slice(since_.cursor.lastIndexOf(':') + 1))
          // `ready` comes before what was missed, so a client says it's back before it says what changed.
          const ready = () => write(`event: ready\ndata: ${JSON.stringify({ cursor: since_.cursor })}\n\n`)
          if (since_.resync) {
            write(`id: ${since_.cursor}\nevent: resync\ndata: {}\n\n`)
            ready()
          } else {
            ready()
            for (const record of since_.changes) send(record)
          }
          for (const record of held) if (record.seq > last) send(record)
          held = null
        }).catch((error) => {
          log(`nebula-files: the feed of ${id}: ${error.stack ?? error}`)
          end()
        })
      },
      cancel: finish,
    })
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    })
  }

  // --- requests ------------------------------------------------------------------------------

  /** Whether a request may reach the API: a Host this serves, and never another site. `hostCount`
   * and `remoteAddress` are what the server saw (Node's http passes both; another host what it can). */
  function refusal(request, url, { hostCount, remoteAddress } = {}) {
    const host = String(request.headers.get('host') ?? url.host).toLowerCase()
    let name = ''
    try {
      // Two Host headers arrive as one value, 'a, b', which isn't a host name.
      name = (hostCount ?? 1) === 1 && !/[/?#@\\]/.test(host) ? new URL(`http://${host}`).hostname : ''
    } catch {
      // not a host name
    }
    if (!LOOPBACK.has(name) && !allowed.has(name)) return [421, 'host', `This server doesn't answer for ${JSON.stringify(host)}`]
    // nebula run on a laptop: a loopback name counts only from this machine.
    if (loopbackPeer && LOOPBACK.has(name) && !isLoopbackAddress(remoteAddress)) return [421, 'host', 'A loopback name from another machine']
    const site = request.headers.get('sec-fetch-site')
    const safe = request.method === 'GET' || request.method === 'HEAD'
    if (site && site !== 'same-origin' && !(site === 'none' && safe)) return [403, 'cross-site', 'Another site asked']
    const origin = request.headers.get('origin')
    if (origin !== null) {
      let originHost = null
      try {
        originHost = new URL(origin).host.toLowerCase()
      } catch {
        // an opaque origin ("null")
      }
      if (originHost !== host) return [403, 'cross-site', 'Another site asked']
    }
    return null
  }

  async function place(request, url, actor) {
    const scopeNow = typeof scope === 'function' ? await scope(request, actor) : scope
    if (scopeNow !== undefined && !SCOPE.test(scopeNow)) throw new Error(`scope gave ${JSON.stringify(scopeNow)}, not an opaque id of at most 128 link characters`)
    const space = await spaceFor(request, actor)
    const forwarded = request.headers.get('x-forwarded-proto')
    const proto = forwarded === 'https' || (!forwarded && url.protocol === 'https:') ? 'https' : 'http'
    return {
      version: 1,
      place: { tier: 'server', label, url: `${proto}://${request.headers.get('host') ?? url.host}` },
      // What the app may offer beside this server, whose it is, and what the backend can do.
      homes: offered,
      ...(scopeNow === undefined ? {} : { scope: scopeNow }),
      // Who is asking, as their changes will name them: the app says "you" for these.
      you: actor,
      capabilities: {
        createProject: backend.capabilities?.createProject === true,
        versions: backend.capabilities?.versions === true,
        removeProject: backend.capabilities?.removeProject === true,
        deletedFiles: backend.capabilities?.deletedFiles === true,
      },
      // How much is used, and the allowance where the host sets one (the person's Settings say so).
      ...(space === null ? {} : { space }),
      projects: (await listProjects(actor)).map(publicInfo),
    }
  }

  /** The changes the Suite's last-modified list and notifications read: one project's, or all. */
  async function changes(url, actor) {
    const project = url.searchParams.get('project') || undefined
    const path = url.searchParams.get('path') || undefined
    const before = url.searchParams.get('before') || undefined
    const limitParam = url.searchParams.get('limit')
    const limit = limitParam === null ? 50 : Number(limitParam)
    if (!Number.isInteger(limit) || limit < 1 || limit > RECENT_LIMIT) throw new BackendError('invalid-query', `limit is a whole number from 1 to ${RECENT_LIMIT}`)
    if (before !== undefined && !TOKEN.test(before)) throw new BackendError('invalid-query', 'before is a page’s next, as the last answer gave it')
    if (path !== undefined && pathProblem(path)) throw new BackendError('invalid-path', `Invalid path ${JSON.stringify(path)}: ${pathProblem(path)}`)
    if (project !== undefined) await backend.project(project, { actor })
    const page = await backend.recent({ project, path, limit, before })
    return { changes: page.changes.map(publicRecord), next: page.next }
  }

  /** New project, where the backend makes projects (capabilities.createProject): `{ name, color? }`,
   * answered 201 with the project. A backend that can't (folders today) answers 405 `not-supported`. */
  async function newProject(request, actor) {
    if (backend.capabilities?.createProject !== true || typeof backend.createProject !== 'function') {
      return json(405, { error: 'not-supported', message: 'This server doesn’t make new projects' }, { allow: 'GET' })
    }
    if (!/^application\/json(;|$)/i.test(request.headers.get('content-type') ?? '')) throw new BackendError('project-meta', 'A new project is asked for as JSON: { "name": "…", "color": "#rrggbb" }')
    let size = 0
    const chunks = []
    for await (const chunk of request.body ?? []) {
      size += chunk.byteLength
      if (size > NEW_PROJECT_MAX) throw new BackendError('too-large', `A new project's request is at most ${NEW_PROJECT_MAX} bytes`)
      chunks.push(chunk)
    }
    let asked
    try {
      asked = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new BackendError('project-meta', 'A new project is asked for as JSON: { "name": "…", "color": "#rrggbb" }')
    }
    const name = typeof asked?.name === 'string' ? asked.name.trim() : ''
    if (!name || name.length > NAME_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new BackendError('project-meta', `A project’s name is one line of 1 to ${NAME_MAX} characters`)
    if (asked.color !== undefined && (typeof asked.color !== 'string' || !COLOUR.test(asked.color))) throw new BackendError('project-meta', 'A project’s colour is written #rrggbb')
    const made = await backend.createProject({ name, ...(asked.color ? { color: asked.color.toLowerCase() } : {}) }, { actor })
    await listProjects(actor)
    return json(201, { project: publicInfo(made) })
  }

  /** 405 `not-supported`, for what this backend can't do (a capability it lacks). */
  const notSupported = (message) => json(405, { error: 'not-supported', message })
  const can = (capability, method) => backend.capabilities?.[capability] === true && typeof backend[method] === 'function'

  /** A project's id from the path, or `no-project`. */
  function projectIdIn(text) {
    try {
      return decodeURIComponent(text)
    } catch {
      throw new BackendError('no-project', 'No such project here')
    }
  }

  /** A file's bytes as `GET …/file` answers them, `extra` headers beside. */
  async function fileResponse(method, file, extra = {}) {
    const fileHeaders = {
      'content-type': 'application/octet-stream',
      'content-length': String(file.size),
      etag: etagOf(file.version),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      ...extra,
    }
    if (method === 'HEAD') {
      await file.body.cancel()
      return new Response(null, { status: 200, headers: fileHeaders })
    }
    return new Response(file.body, { status: 200, headers: fileHeaders })
  }

  /** The removed projects' routes: `DELETE <api>/projects/<id>`, `GET <api>/removed-projects`,
   * `POST <api>/removed-projects/<id>/restore`. Null for any other request. */
  async function removedRoutes(request, rest, actor, author) {
    const { method } = request
    const whole = /^\/projects\/([^/]+)$/.exec(rest)
    const back = /^\/removed-projects\/([^/]+)\/restore$/.exec(rest)
    const listing = rest === '/removed-projects'
    if (!(whole && method === 'DELETE') && !(back && method === 'POST') && !(listing && method === 'GET')) return null
    if (!can('removeProject', 'removeProject')) return notSupported('This server doesn’t keep removed projects: a project here can’t be removed through Nebula')
    if (listing) return json(200, { projects: await backend.removedProjects() })
    if (whole) {
      const removed = await backend.removeProject(projectIdIn(whole[1]), author)
      await listProjects(actor)
      return json(200, { removed })
    }
    const project = await backend.restoreProject(projectIdIn(back[1]), author)
    await listProjects(actor)
    return json(200, { project: publicInfo(project) })
  }

  async function route(request, url, actor) {
    const { method, headers } = request
    const rest = url.pathname.slice(apiBase.length)
    const clientHeader = headers.get('nebula-client')
    const author = {
      actor,
      context: contextOf(headers.get('nebula-context')),
      client: clientHeader && CLIENT.test(clientHeader) ? clientHeader : undefined,
    }
    if (rest === '/place' && method === 'GET') return json(200, await place(request, url, actor))
    if (rest === '/changes' && method === 'GET') return json(200, await changes(url, actor))
    if (rest === '/projects' && method === 'POST') return newProject(request, actor)
    const removedAnswer = await removedRoutes(request, rest, actor, author)
    if (removedAnswer) return removedAnswer
    const match = /^\/projects\/([^/]+)\/(state|list|stat|file|mkdir|rename|events|versions|version|restore|deleted)$/.exec(rest)
    if (!match) throw new BackendError('no-route', 'Not part of the file API')
    const action = match[2]
    const history = action === 'versions' || action === 'version' || action === 'restore'
    if (history && !can('versions', 'versions')) return notSupported('This server doesn’t keep earlier versions of files')
    if (action === 'deleted' && !can('deletedFiles', 'deletedFiles')) return notSupported('This server doesn’t list deleted files')
    const id = projectIdIn(match[1])
    const project = await backend.project(id, { actor })
    const path = url.searchParams.get('path') ?? ''

    if (action === 'state' && method === 'GET') return json(200, { cursor: await backend.cursor(id), project: publicInfo(project) })
    if (action === 'list' && method === 'GET') {
      const entries = await backend.list(id)
      return json(200, { entries, cursor: await backend.cursor(id) })
    }
    if (action === 'events' && method === 'GET') return events(request, id, url.searchParams.get('since') ?? headers.get('last-event-id') ?? '')
    if (action === 'stat' && method === 'GET') {
      const found = await backend.stat(id, path)
      if (!found) throw new BackendError('not-found', `Nothing exists at ${JSON.stringify(path)}`)
      return json(200, { entry: found.entry, etag: found.version === null ? null : etagOf(found.version) }, { 'nebula-cursor': await backend.cursor(id) })
    }
    if (action === 'file' && (method === 'GET' || method === 'HEAD')) return fileResponse(method, await backend.read(id, path))
    if (action === 'deleted' && method === 'GET') {
      const limitParam = url.searchParams.get('limit')
      const limit = limitParam === null ? DELETED_LIMIT : Number(limitParam)
      if (!Number.isInteger(limit) || limit < 1 || limit > DELETED_LIMIT_MAX) throw new BackendError('invalid-query', `limit is a whole number from 1 to ${DELETED_LIMIT_MAX}`)
      return json(200, await backend.deletedFiles(id, { limit }))
    }
    if (action === 'versions' && method === 'GET') {
      const limitParam = url.searchParams.get('limit')
      const limit = limitParam === null ? 50 : Number(limitParam)
      if (!Number.isInteger(limit) || limit < 1 || limit > VERSIONS_LIMIT) throw new BackendError('invalid-query', `limit is a whole number from 1 to ${VERSIONS_LIMIT}`)
      const before = url.searchParams.get('before') || undefined
      if (before !== undefined && !TOKEN.test(before)) throw new BackendError('invalid-query', 'before is a page’s next, as the last answer gave it')
      return json(200, await backend.versions(id, path, { limit, before }))
    }
    // A version, as `versions` gave it; checked here as `before` is, so nothing else reaches the backend.
    const version = () => {
      const asked = url.searchParams.get('version') ?? ''
      if (!TOKEN.test(asked)) throw new BackendError('invalid-query', 'version is one of the file’s versions, as versions gave it')
      return asked
    }
    if (action === 'version' && (method === 'GET' || method === 'HEAD')) {
      const file = await backend.readVersion(id, path, version())
      return fileResponse(method, file, { 'nebula-version': file.version })
    }
    if (action === 'restore' && method === 'POST') {
      const asked = version()
      const ifMatch = headers.get('if-match')
      const ifAbsent = headers.get('if-none-match') === '*'
      // A restore always says what it replaces, so it never lands over a change its maker didn't see.
      if (!ifMatch && !ifAbsent) throw new BackendError('precondition', 'A restore names the version it replaces: If-Match: "<etag>", or If-None-Match: * when the file is gone')
      // A path that is taken is 412, whichever file took it: the version asked for may belong to the
      // file that was there before, which the backend would then call no version of this path.
      if (ifAbsent && (await backend.stat(id, path))) throw new BackendError('precondition', `Something already exists at ${JSON.stringify(path)}`, { exists: true })
      // A restore brings bytes back into the tree, so it meets the account's allowance as a write
      // does: the version's size in place of the current file's (none when the file is gone).
      const kept = await backend.readVersion(id, path, asked)
      await kept.body.cancel()
      await roomFor(request, actor, kept.size, (await backend.stat(id, path))?.entry.size ?? 0)
      const result = await backend.restore(id, path, asked, {
        ...author,
        ifAbsent,
        ifMatch: ifMatch && !ifAbsent ? versionIn(ifMatch) : undefined,
        parents: headers.get('nebula-parents') !== 'existing',
      })
      const etag = etagOf(result.version)
      return json(200, { entry: result.entry, etag, cursor: result.cursor }, { etag })
    }
    if (action === 'file' && method === 'PUT') {
      const ifMatch = headers.get('if-match')
      const result = await backend.write(id, path, await accepted(request, actor, id, path), {
        ...author,
        ifAbsent: headers.get('if-none-match') === '*',
        ifMatch: ifMatch ? versionIn(ifMatch) : undefined,
        parents: headers.get('nebula-parents') !== 'existing',
      })
      const etag = etagOf(result.version)
      return json(200, { entry: result.entry, etag, cursor: result.cursor }, { etag })
    }
    if (action === 'file' && method === 'DELETE') return json(200, await backend.remove(id, path, author))
    if (action === 'mkdir' && method === 'POST') return json(200, await backend.mkdir(id, path, author))
    if (action === 'rename' && method === 'POST') return json(200, await backend.rename(id, url.searchParams.get('from') ?? '', url.searchParams.get('to') ?? '', author))
    throw new BackendError('method', `${method} isn't allowed here`)
  }

  /**
   * Answers a request under the API with a Response, or null for any other path. `info` is what the
   * server saw of the connection: `remoteAddress` (for `loopbackPeer`) and `hostCount`.
   * @param {Request} request
   * @param {{ remoteAddress?: string, hostCount?: number }} [info]
   * @returns {Promise<Response | null>}
   */
  async function fetchApi(request, info = {}) {
    const url = new URL(request.url)
    if (!isApiPath(url.pathname)) return null
    const refused = refusal(request, url, info)
    if (refused) return json(refused[0], { error: refused[1], message: refused[2] })
    // An upload that says it's over the cap is refused before a byte of it is read.
    const declared = request.headers.get('content-length')
    if (declared !== null && declaredLength(declared) > maxBytes) return json(413, { error: 'too-large', message: `The file is over ${maxBytes} bytes` })
    try {
      const resolved = await resolve(request)
      if (resolved instanceof Response) return resolved
      const actor = actorIn(resolved?.actor)
      if (!actor) throw new Error('resolve gave no actor ({ type: "human" | "agent", id, name })')
      return await route(request, url, actor)
    } catch (error) {
      if (error instanceof BackendError) return json(error.status, { error: error.code, message: error.message, ...error.extra })
      log(`nebula-files: ${request.method} ${url.pathname}: ${error.stack ?? error}`)
      return json(500, { error: 'internal', message: 'The server could not do that' })
    }
  }

  /** Answers a request under the API and returns true; returns false for anything else. Node's
   * http, over `fetch`: bodies stream both ways. */
  async function handle(req, res) {
    const target = new URL(req.url ?? '/', 'http://nebula.local')
    if (!isApiPath(target.pathname)) return false
    let hostCount = 0
    const headers = new Headers()
    let request
    const body = req.method === 'GET' || req.method === 'HEAD' ? null : webBody(req)
    if (!body) req.resume()
    const gone = new AbortController()
    res.on('close', () => gone.abort())
    try {
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        if (req.rawHeaders[index].toLowerCase() === 'host') hostCount += 1
        headers.append(req.rawHeaders[index], req.rawHeaders[index + 1])
      }
      request = new Request(target, { method: req.method, headers, body: body?.stream, duplex: 'half', signal: gone.signal })
    } catch {
      if (declaredLength(req.headers['content-length']) <= maxBytes) body?.drain()
      else if (body) res.setHeader('connection', 'close')
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad request')
      return true
    }
    const response = await fetchApi(request, { remoteAddress: req.socket.remoteAddress, hostCount })
    if (body && !body.ended()) {
      // What the route didn't read of a body no bigger than the cap is read and dropped, so the
      // connection can carry the next request. One over the cap, or of unknown size, is never
      // read on: the answer goes, and the connection closes behind it.
      if (declaredLength(req.headers['content-length']) <= maxBytes) body.drain()
      else res.setHeader('connection', 'close')
    }
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (!response.body || req.method === 'HEAD') {
      await response.body?.cancel()
      res.end()
    } else await pipeBody(response.body, res)
    return true
  }

  return {
    fetch: fetchApi,
    handle,
    close: () => backend.close(),
    ready: () => listProjects().then(() => {}),
    projects: () => known.map(({ folder: _folder, ...info }) => info),
    backend,
    apiBase,
    roomFor,
    /** The Server-Timing value to put on the app's pages (and every response) when this API is mounted. */
    serverTiming,
  }
}

/** A Content-Length as a number of bytes: Infinity when there is none or it isn't one, so an
 * unknown size counts as over any cap. */
function declaredLength(value) {
  return value !== null && value !== undefined && /^\d+$/.test(String(value).trim()) ? Number(value) : Infinity
}

/** A Node request's body as a web stream that reads only as fast as it's read. `drain` drops the
 * rest; a reader that stops (an upload over the cap) leaves the rest unread, and `ended` says
 * whether the body came in whole. */
function webBody(req) {
  let done = false
  let ended = false
  const drain = () => {
    done = true
    req.resume()
  }
  const stream = new ReadableStream(
    {
      start(controller) {
        req.on('data', (chunk) => {
          if (done) return
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
          if (controller.desiredSize <= 0) req.pause()
        })
        req.on('end', () => {
          ended = true
          if (done) return
          done = true
          controller.close()
        })
        const fail = (error) => {
          if (done) return
          done = true
          controller.error(error)
        }
        req.on('error', fail)
        // A sender that went away mid-body: the write stops, and its temporary file goes.
        req.on('close', () => {
          if (!req.complete) fail(new Error('The request ended before its body did'))
        })
        req.pause()
      },
      pull() {
        if (!done) req.resume()
      },
      cancel() {
        done = true
      },
    },
    { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength },
  )
  return { stream, drain, ended: () => ended }
}

/** Until the response can take more, or is gone; both listeners go either way. */
function drained(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.on('drain', done)
    res.on('close', done)
  })
}

/** A web stream, to a Node response; a reader that goes away cancels it, so the backend lets go. */
async function pipeBody(body, res) {
  const reader = body.getReader()
  const stop = () => void reader.cancel().catch(() => {})
  res.on('close', stop)
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (!res.write(value)) await drained(res)
      if (res.destroyed) return stop()
    }
    res.end()
  } catch {
    res.destroy()
  } finally {
    res.off('close', stop)
  }
}
