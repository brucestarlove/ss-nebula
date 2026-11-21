# Hosting Nebula

How a host serves Nebula, meaning its page, its assets and its file API, under a path of its own with one call. `nebula run` is the first such host (at the root, over folders); the Starscape Suite mounts it at `suite.starscape.app/nebula` over its database. The interface every backend keeps, and what each method guarantees, is in `cli/backend.mjs`.

## The call

`cli/app.mjs` exports `createNebulaApp`. It uses Node built-ins only.

```js
import { createNebulaApp } from './cli/app.mjs'

const nebula = createNebulaApp({
  basePath: '/nebula',          // '' at the root
  assets: 'dist/app',           // the built app (pnpm run build:cli-app)
  files: {                      // createFilesApi's options, or a createFilesApi instance
    backend,                    // where the projects are kept (cli/backend.mjs)
    resolve,                    // who is asking: (request) => ({ actor }) or a Response that refuses
    homes: ['server'],          // what the app may offer beside the server
    scope: accountScope,        // whose this is, for what the device notes
    allowHosts: ['suite.starscape.app'],
    label: 'Starscape',         // what the app calls the place: "Kept by Starscape"
  },
  frameAncestors: "'self'",     // who may frame the page
})

nebula.fetch(request, { remoteAddress })  // a Response, or null for a path outside the base
nebula.handle(req, res)                   // the same over Node's http: true when it answered
nebula.close()                            // stops the file API's feeds
```

### Options

- **`basePath`**: `''` for the root, or a path such as `/nebula`, with no trailing slash. Under it Nebula answers:
  - `<base>`, `<base>/` and every app route (`<base>/p/<project>/<path>`, and any path with no extension): the page;
  - `<base>/assets/…` and the built app's other files;
  - the file API, at `<base>/nebula-api/v1` unless `files.apiBase` names another path.
  - Anything else under the base is a 404, and anything outside it is the host's (`fetch` returns null, `handle` false).
  - At the root, the site's addresses (`/app`, `/app/p/…`) redirect to the same path without `/app`, so a link copied from nebula.starscape.app opens.
- **`assets`**: the built app's folder. `build:cli-app` builds it with relative URLs (Vite `base: './'`), and the page Nebula serves carries `<base href="<basePath>/">`, so every asset, chunk, font and icon resolves under the mount, and the app reads its mount from that tag (`src/app/routes.ts` `appMount`). A mounted page leaves out the manifest link, whose icons and start page name the root. The build copies `routes.json` beside the app: its rule for `/app` is the page's security headers, the one source of them.
- **`files`**: the file API (`cli/nebula-files.mjs` `createFilesApi`), or its options. Without it the page carries no mark, and the app keeps its projects in the browser. Its options that matter to a host:
  - **`apiBase`**: where the API answers, `<basePath>/nebula-api/v1` by default. The Server-Timing mark on every response names it (`nebula-files;desc="/nebula/nebula-api/v1"`), and the app reads it from there (`src/app/serverTier.ts`), so the app and its API can't disagree.
  - **`backend`**: where the projects are kept (folders, memory, the database). Folders from `roots` and `projectsDirs` by default.
  - **`resolve(request)`**: who is asking, called before every route after the Host and site checks. Return `{ actor: { type: 'human' | 'agent', id, name } }`, or a `Response` that refuses (a 401). Every change records the actor, the time and the `Nebula-Context` the writer names.
  - **`homes`**: the homes a project may have in the app: `'browser'` (the browser's own storage), `'folder'` (a folder the person picks; it needs `'browser'`, where Nebula keeps its list) and `'server'`. Every one by default; it must list `'server'`. `GET <api>/place` announces it.
  - **`scope`**: an opaque id of the host's choosing, or `(request, actor) => id`. The app keys what it notes on the device about this server's projects (when each was last opened) by it, so one account's recent projects don't show for another who signs in on the same computer. Use an id that says nothing about the person (an account id, never an email).
  - **`allowHosts`**: the Host names it answers besides loopback; anything else is refused (421). **`loopbackPeer`** stays off behind a proxy.
  - **`maxBytes`**: the largest upload. One that says it's larger is refused at once (413), and one of unknown size is refused as it passes the cap, with the connection closed.
  - **`allowance`**: how much the workspace may hold, in bytes, or `(request, actor) => ({ bytes, upgrade? } | number | undefined)`. See "Allowance and signing in".
- **`frameAncestors`**: who may frame the page, as CSP sources: `'self'` by default, `'none'` for `nebula run`, or origins such as `https://suite.starscape.app`. It replaces only the policy's `frame-ancestors`; the rest of the policy is routes.json's.

### What the place says

`GET <api>/place` answers:

```json
{
  "version": 1,
  "place": { "tier": "server", "label": "Starscape", "url": "https://suite.starscape.app" },
  "homes": ["server"],
  "scope": "acct_7f3k2",
  "you": { "type": "human", "id": "acct_7f3k2", "name": "Aeva" },
  "capabilities": { "createProject": true, "versions": true, "removeProject": true, "deletedFiles": true },
  "space": { "used": 41230112, "limit": 1073741824, "upgrade": "https://suite.starscape.app/billing" },
  "projects": [{ "id": "k3v9w2", "name": "Orion", "color": "#7c8cff", "created": "…", "createdBy": "acct_7f3k2" }]
}
```

`you` is who is asking, as their changes will name them (the app says "you" for their own). `capabilities` says what the backend can do: make projects, keep earlier versions, remove projects, list deleted files. `space` is there when the host sets an allowance (below).

With only `server`, the app never opens the browser's storage: it lists no browser or folder projects, makes no sample, writes nothing to OPFS, hides Open a folder… and Move to a folder…, and says where files are as "Kept by <label>". New project makes the project with `POST <api>/projects` (`{ name, color? }`, answered 201 `{ project }`) when the backend can (`capabilities.createProject`); a backend that can't answers 405 `not-supported`. With every home, New project offers "On <label>" beside the browser and a folder where the server can make projects.

## One handler per workspace

Make one `createNebulaApp` per open workspace, over that workspace's backend, and keep it while it's used. Then a handler never sees two workspaces' projects, its change feeds are the workspace's, and closing an idle one (`close()`) ends its feeds. The page's address doesn't say which workspace: the host picks the handler from the signed-in session. The handler's `scope` keys the device's notes, so make it the account's (a function of the request) when people share a workspace.

## Who owns what

The host owns:

- sign-in, and the session that says which account and workspace a request is for;
- the actor on every request (`resolve`), and refusing what the account may not do;
- the workspace, its backend and its storage allowances (quota, upload size);
- the handler cache: one handler per open workspace, closed when idle;
- the frame around Nebula, and what it says when Nebula is shown or hidden;
- the Host names it serves and the TLS in front of them.

Nebula owns:

- the page, its assets and its security headers (routes.json), with the host's `frame-ancestors`;
- the file API: paths, versions, conditional writes, the change feed, who changed what and when;
- the homes the app offers, as the host says, and the words for where files are kept;
- never deleting or overwriting a file it can't prove it made.

## History and removed projects

On the database backend every file keeps its earlier versions, and a removed project can come back, for 14 days (`keepDays`). The place says so: `capabilities.versions`, `capabilities.removeProject` and `capabilities.deletedFiles` are true. Folders keep neither, and the routes below answer them 405 `{ error: 'not-supported' }`.

**What a host gets:**

- `GET <api>/projects/<id>/versions?path=&limit=&before=`: a file's kept versions, newest first, the current one included (`current: true`), each with when it was written, its size, who wrote it, the context they named, the path it had then (a file keeps its history through renames) and, for a version made by restoring, `restoredFrom`. `limit` is 1 to 200 (50 by default); `before` is the last page's `next`. A deleted file's path still answers, until its versions go.
- `GET <api>/projects/<id>/deleted?limit=` → `{ files, more }`: the files deleted from the project and still restorable, newest delete first (`limit` is 1 to 500, 200 by default; `more` is true when older ones were held back). Each is `{ path, version, size, deletedAt, deletedBy? }`: `version` is the file's last, the one before the delete, for the `restore` below with `If-None-Match: *`. A deleted folder lists the files that were in it, not its folders. It lists a delete for `keepDays`, as long as the sweep keeps that version; a path is listed once, for its latest delete, and only while nothing is at it (a file made there again, a folder, or the file restored). The project's own `.nebula/` files are left out. The place says `capabilities.deletedFiles`; elsewhere the route answers 405 `not-supported`. A restore into a path that is taken answers 412 `precondition` with `exists: true`, whichever file took it, and writes nothing.
- `GET <api>/projects/<id>/version?path=&version=`: one version's bytes, with the headers `GET …/file` sends and `nebula-version`. A version no longer kept answers 404 `not-found`.
- `POST <api>/projects/<id>/restore?path=&version=` with `If-Match: "<current etag>"`, or `If-None-Match: *` when the file is gone now: that version becomes the newest, as a new revision over the same bytes (nothing is copied), logged as a `write` by whoever restored it, with `restoredFrom`. It answers as `PUT …/file` does. A stale `If-Match` answers 412 `precondition`, and so does a restore with neither header. The version it replaced stays in history.
- `DELETE <api>/projects/<id>` → `{ removed }`: the project leaves the list and every route answers 404 `no-project`, its live feeds end (open apps drop it), its files stop counting towards `usage()`, and its id stays taken for good. `GET <api>/removed-projects` lists the ones still restorable, each with `removed`, `removedBy` and `purgeAfter`; `POST <api>/removed-projects/<id>/restore` → `{ project }` brings one back as it was, until it's purged (then 404 `no-project`).
- A save of the same bytes as the file already holds stores nothing and logs nothing: it answers the current version.

**In the log** (`GET <api>/changes`, what a dashboard reads): removing a project is a `remove` whose `path` is `''`, and restoring one is a `mkdir` whose `path` is `''`, both with the actor. No file's path is ever `''`, so these mean only that. The app already reads a `remove` of `''` as "the project was removed on purpose". A restored project starts a new epoch, so a client holding a cursor from before it was removed lists it again. A restore of a file is a `write` with `restoredFrom`.

**The sweep** (`backend.sweep({ now?, keepDays?, graceMinutes? })`) does three things, in this order:

1. It purges each project removed more than `keepDays` ago: its files go from the tree, and its versions with them. Its log rows stay.
2. It thins each file's history. Of the versions younger than `keepDays`, it keeps the current one, the newest in each 10-minute window of the last hour, in each hour of the last day and in each day (UTC) back to `keepDays`. It also keeps the version just before someone else's write, the one a delete let go and the one a restore replaced, each for `keepDays` after that happened. That's about 40 versions a file, however often it's saved: 10,000 saves over 14 days leave 43. Every change stays in the log (who, when, what); a version thinning drops just stops being readable.
3. It removes the bytes nothing keeps any more, once they're older than `graceMinutes` (60), so an upload that hasn't committed is never taken.

It answers `{ purged, dropped, removed, freed, kept, temporary }`. Run it hourly, and at start: the schedule's finest step is 10 minutes, so hourly is often enough and costs little (one read of the kept versions, then one pass over the byte store). `nebula run --database` does exactly that, and logs one line a run. The Suite runs it per workspace on its own timer, and should set its bucket's lifecycle rule no shorter than `keepDays`.

**Upgrading:** a 2.0.3 database (schema 1) is copied whole beside itself, as `nebula.db.schema1-<date>.bak`, the first time 2.0.4 opens it. It's then moved to schema 2 in one transaction, and its earlier writes are named from the log, so the history from before the upgrade can be listed and restored too. A 2.0.3 server can't open the upgraded file for writing: it opens it read-only. Roll back with the copy.

## Allowance and signing in

Both belong to the host. Nebula stores no account and no limit; it enforces the allowance a host gives it and tells the app plainly when a session has ended or a workspace is full.

### The allowance

`createFilesApi`'s `allowance` option (so `files.allowance` in `createNebulaApp`) is a number of bytes, or a function for a handler that serves accounts with different plans:

```js
files: {
  backend,
  resolve,
  // one number for everyone:
  allowance: 1024 ** 3,
  // or per request: bytes, optionally where to get more, or undefined for no limit
  allowance: (request, actor) => {
    const plan = planOf(sessionOf(request).account)
    return plan.unlimited ? undefined : { bytes: plan.bytes, upgrade: 'https://suite.starscape.app/billing' }
  },
}
```

What counts is `backend.usage()`: every current file in the workspace, `.nebula/`'s own included. Earlier versions kept for history are Starscape's cost, not the person's, and aren't counted. `upgrade` is an `http(s)` address or a path on the host (`/billing`); anything else is refused as a mistake in the host's code.

A write is refused when it would take the workspace past the limit, by what it adds less what it replaces:

- A save that doesn't grow usage always passes, whatever the total, so a person who is over can still edit smaller files and trim.
- Removes, renames and new folders are never checked, so they can always delete their way back under.
- A `PUT` that declares a `Content-Length` that wouldn't fit is refused before a byte of it is read. A body of unknown length is read only up to the room left, then refused (and the connection closes behind the answer, as it does past `maxBytes`).
- The count is read at the start of each write, so two writes in flight together can both pass and end a little over. The limit is a fence, not a ledger.

The refusal is `507` with `error: 'space-full'`, never confused with `disk-full` (also 507, the server's own disk):

```json
{
  "error": "space-full",
  "message": "This space is full (1.1 GB of 1 GB used), so that couldn’t be saved",
  "used": 1181116006,
  "limit": 1073741824,
  "upgrade": "https://suite.starscape.app/billing"
}
```

With an allowance set, `GET <api>/place` carries `space: { used, limit?, upgrade? }`, with `limit` left out when the function answers `undefined`. Without the option, the place says nothing of space and nothing is limited. `createFilesApi` also returns `roomFor(request, actor, adding, replacing)` for a host's own routes: it answers how many bytes the new file may take (`Infinity` with no limit) and throws the same `space-full` when `adding` doesn't fit.

### Signing in

When a session has ended, `resolve` answers the request with `signedOut`, exported from `cli/nebula-files.mjs`:

```js
import { signedOut } from '@starlove/nebula/files'

resolve: (request) => {
  const session = sessionOf(request)
  if (!session) return signedOut({ signIn: '/sign-in?next=/nebula' })
  return { actor: { type: 'human', id: session.account.id, name: session.account.name } }
},
```

That is a `401` with `cache-control: no-store` and the body `{ "error": "signed-out", "message": "…", "signIn": "/sign-in?next=/nebula" }`; `message` has a plain default and `signIn` is optional (same rule as `upgrade`). The change feed's reconnect gets the same answer, so a host needs nothing more. A bare `new Response('…', { status: 401 })` still refuses the request, but the app can't tell it from a failure, so use `signedOut`.

What the app does with it: a save that fails because the person is signed out or the space is full keeps the edit, as every failed save does, and the save bar says why in words with the way out: "Sign in again" (the `signIn` address) or "Get more space" (`upgrade`). A banner says it once for the whole workspace. The live feed stops retrying while signed out and resumes after sign-in. Settings shows the space used.

## Holding a backend to the rules

Nebula's own backends and byte stores pass the same cases, and a host's must too: the Suite's bucket store and its database backend over that store are Nebula's contract, whoever wrote them. The cases are exported as two modules that import only `node:assert/strict` and `node:crypto`, load no `node:sqlite` and work on Node 20.19, so the host's CI can run them without a framework:

- `@starlove/nebula/conformance/bytes` holds a byte store to the header of `cli/bytes/store.mjs` (20 cases): `put` answers the exact size and sha256 and only once the bytes are readable and listed; past `maxBytes` it rejects `too-large`, stops reading and keeps nothing; ids are random, shaped as `OBJECT_ID`, never reused, even after a delete; `get` gives the same bytes every time and `no-object` for an id it doesn't hold (or one that isn't an id); `delete` resolves either way; `list` reports every object with an `at` in milliseconds no later than `put` resolving.
- `@starlove/nebula/conformance/backend` holds a `ProjectBackend` to the JSDoc of `cli/backend.mjs` (51 cases), through the interface itself and not over HTTP: whole-file replacement and its atomicity; `ifMatch` and `ifAbsent` and their 412 details (`absent`, `exists`); `parents: false`; rename refusing an existing target and a folder into itself, with versions following a rename; removing a file and a folder; the hidden names, `.nebula` and `project.json` rules; the log's order, cursors and `changesSince` (`resync` for another epoch's cursor or one ahead); `recent`'s pages and path filter; `subscribe` hearing a change and stopping; `close` ending the feeds; `usage`; `createProject`; and, for a backend that claims `capabilities.versions`, `versions` (newest first, the current one first, paged, a deleted file's by its last path), `readVersion`, `restore` (`ifMatch`, `ifAbsent`, `restoredFrom` in the log and on the feed), a save of identical bytes storing nothing, and what thinning keeps after `sweep()` where the backend has one; and, for `capabilities.removeProject`, `removeProject`, `removedProjects` and `restoreProject`. It reads `capabilities` and leaves out a case for what the backend doesn't claim (such a case returns at once, so a runner shows it as passed).

A backend that doesn't claim `versions` isn't held to the identical save (a folder may store a revision for it), and none is held to what a restart does to the log (`durableHistory`): that needs the same storage opened twice, which only the host can do.

Each module exports `register({ describe, it }, title, make)` and the list itself (`byteStoreCases(make)`, `backendCases(make)`, each `{ name, run }[]`). `make` is called once per case, so no case depends on another and a runner needs no hooks. It answers what to test, or an object with a `dispose` to clean up after the case:

- bytes: a store, or `{ store, dispose }`. Give each call an empty store of its own, or a prefix of its own in a shared bucket: `list()` is read as the whole store, and the cases count what is in it.
- backend: a backend, or `{ backend, newProject?, dispose? }`. `newProject()` makes a project and answers its id, for a backend that makes none itself (`capabilities.createProject` false); without it the cases use `createProject`. The cases call the backend's `close()` for you. A database backend must have a byte store no other workspace shares (its sweep removes every object it doesn't name), so give each call its own prefix.

### In vitest

```js
import { describe, it } from 'vitest'
import { register as registerBackend } from '@starlove/nebula/conformance/backend'
import { register as registerBytes } from '@starlove/nebula/conformance/bytes'
import { createDatabaseBackend } from '@starlove/nebula/backends/database'

const freshPrefix = () => `conformance-${crypto.randomUUID()}/`

registerBytes({ describe, it }, 'bucket store', () => {
  const prefix = freshPrefix()
  return { store: createBucketStore({ bucket, prefix, key }), dispose: () => emptyPrefix(bucket, prefix) }
})

registerBackend({ describe, it }, 'database backend over the bucket store', () => {
  const prefix = freshPrefix()
  const folder = mkdtempSync(join(tmpdir(), 'suite-conformance-'))
  const bytes = createBucketStore({ bucket, prefix, key })
  return {
    backend: createDatabaseBackend({ file: join(folder, 'nebula.db'), bytes }),
    dispose: async () => {
      await emptyPrefix(bucket, prefix)
      rmSync(folder, { recursive: true, force: true })
    },
  }
})
```

`createBucketStore`, `bucket`, `key` and `emptyPrefix` are the Suite's. Under vitest's `vmThreads` pool, arrays that come from node:sqlite belong to another realm and `assert.deepEqual` fails on equal values; the backend cases compare through a copy for that reason, so they run there as in any pool. A case that waits on a feed gives up after 3 s, and the default 5 s timeout of a test is enough for a local store; raise the runner's test timeout (`testTimeout` in vitest) for a bucket across the network.

### In node:test

```js
import { describe, it } from 'node:test'
import { register } from '@starlove/nebula/conformance/bytes'

register({ describe, it }, 'bucket store', () => ({ store: makeBucketStore(), dispose: cleanUp }))
```

`node --test conformance.test.mjs` runs them. Any runner works that has `describe(title, body)` and `it(name, run)`; for a runner that has neither, loop over `byteStoreCases(make)` and call `run()` on each: it throws when a rule is broken.

## In a frame

The Suite's shell frames its apps (Orbit, Nebula, Pulse, games), and the apps and the shell talk with a handful of messages. They are written once, here, for every Starscape app: nothing in them belongs to Nebula alone, and an app that has no use for one ignores it. Nebula's side is `src/app/frameBridge.ts`; the shapes are typed in `src/files/serverContract.ts` (`HostMessage`, `AppMessage`).

### The rule

- Every message is an object with `starscape: 1` and a `type`. Anything else is ignored.
- The app talks only to its own parent window (`window.parent`), and only on its own origin. It acts on a message only if `event.source` is `window.parent`, `event.origin` is the app's own origin, and `starscape` is `1`. It sends with `window.parent.postMessage(message, <its own origin>)`, never `*`. The host does the same the other way round: it acts only on messages from the app's frame window on its own origin, and sends with that origin as the target.
- A page that isn't framed (`window.parent === window`) listens to no one and sends nothing. A host never needs to know whether an app is framed.
- So a framed app and its host share an origin. The Suite mounts Nebula at `/nebula` on its own origin, and `frameAncestors: "'self'"` (the default) is what lets it frame the page. A host on another origin can frame the page with `frameAncestors` naming it, but the messages will not pass: the app ignores another origin's, by design.
- A `sandbox` on the frame needs `allow-same-origin` (the app's origin is how the messages pass) and `allow-scripts`; add `allow-forms`, `allow-downloads` and `allow-popups` for uploads, Download and Sign in again.
- The host sends nothing before the app says `ready`: the app starts listening once its workspace is up.

### From the host to the app

| `type` | Shape | What Nebula does |
|---|---|---|
| `hello` | `shortcuts?: string[]` | Lists the keys the host keeps for itself. For those, the app sends `shortcut` and does nothing else. Each `hello` replaces the last list, and an empty one gives the keys back. |
| `visibility` | `visible: boolean` | Hidden, the app lets go of its live feed of every open project (no connection is held while the frame is out of sight, and nothing is shown as an outage). Shown, it takes the feeds up again from where each stopped, so nothing made meanwhile is missed, and a signed-out session looks again. |
| `navigate` | `project?: string`, `path?: string`, `context?: string` | Opens the project (the open one when absent) and the file in it, as an address `/p/<project>/<path>` would. A `context` becomes the link that file's writes name (below). A file that isn't there says so in the status line. |

Shortcut strings are modifiers then a `KeyboardEvent.key`, joined by `+`: `Mod+K` (`Mod` is ⌘ on Apple devices and Ctrl elsewhere), `Ctrl+Shift+P`, `Alt+Shift+ArrowLeft`, `Escape`. Letters match in either case, and the modifiers must be exactly those listed. A key with no Ctrl, ⌘ or Alt that is typed into a text field is text, and stays the app's. Ctrl/⌘-K is Nebula's own search: it is the host's only if the host lists it.

### From the app to the host

| `type` | Shape | When |
|---|---|---|
| `ready` | `app: string`, `version: string` | Once, when the workspace is up: the project list is loaded and the open project is ready. |
| `title` | `title: string` | When the active file changes: `<file> · <project>`, the project alone with no file, `Nebula` with no project. Not repeated for the same title. |
| `shortcut` | `key: string` | A key the host kept (the string as the host listed it). The app didn't act on it. |
| `sign-in` | none | The session has ended and the person chose Sign in again. The host signs them in (the app keeps their unsaved edits, and saves them once the session is back). |

### Pausing

A hidden frame holds no live connection. The host says so with `visibility`, and the app also lets go of its feeds when its own tab has been hidden for 60 seconds (`document.hidden`), framed or not. The two hold the pause together: it ends only when the frame is shown and the tab is visible. Resuming reads from the cursor each feed holds, so a host needn't reload anything; if the server has dropped that cursor, the app resyncs, as after any drop.

### Signed out

When the host's `resolve` answers a request with `signedOut()` (a 401; see "Allowance and signing in"), Nebula keeps every unsaved edit where it was made and says so: a banner for the workspace, and in each file's own bar, "You're signed out. Your changes are kept here until you sign in again." with Sign in again. In a frame, that button sends `sign-in`; alone, it opens the `signIn` address the host gave, or the app's own address, in a new tab. The live feed stops retrying while signed out. Nebula looks again when the tab regains focus or becomes visible, when the frame is shown, and when the person presses Try again; the first answered request ends it, and the edits are saved. A host that signs the person in again should send `visibility` with `visible: true` (or reload the frame): either is enough.

### An Orbit card's context

A file opened from an Orbit card carries the card's link, `orbit:card/<board>/<n>`, in one of two places: `?context=` on the file's address (`/nebula/p/<project>/<path>?context=orbit:card/<board>/<n>`), or the `context` of a `navigate`. The value is checked against the server's rule (link characters, 1 to 256; anything else is dropped and the file still opens). Nebula then sends it as `Nebula-Context` with every write, rename and remove of that file from that tab, follows the file through renames made there, and shows a small "From an Orbit card" mark where the file is open. Nothing about it is stored on the device, and the address loses the query once the file is open. The server keeps the link as given in the change record (and on each version), so the Suite's dashboard and history can say which card a change came from.

### How a host frames Nebula

```html
<iframe id="nebula" src="/nebula/p/night-sky/Notes/Orion.md?context=orbit:card/main/12" title="Nebula"></iframe>
```

```js
const frame = document.getElementById('nebula')
const origin = window.location.origin

addEventListener('message', (event) => {
  // The same three checks the app makes of the host.
  if (event.source !== frame.contentWindow || event.origin !== origin || event.data?.starscape !== 1) return
  const message = event.data
  if (message.type === 'ready') {
    send({ type: 'hello', shortcuts: ['Mod+K'] }) // the host keeps Ctrl/⌘-K for its own search
    send({ type: 'visibility', visible: !document.hidden && frameIsShown() })
  } else if (message.type === 'title') document.title = `${message.title} · Starscape`
  else if (message.type === 'shortcut') openSuiteSearch(message.key)
  else if (message.type === 'sign-in') location.assign('/sign-in?next=/nebula')
})

const send = (message) => frame.contentWindow.postMessage({ starscape: 1, ...message }, origin)
// When the person switches app or tab: send({ type: 'visibility', visible: false }), and true on return.
// To open a card's file in the frame already there: send({ type: 'navigate', project, path, context })
```

Orbit, Pulse and a game follow the same rule with the messages they use: `ready`, `title` and `visibility` need no more than this, and an app that has no files ignores `navigate`.

## The Suite (Hono)

The Suite runs Nebula's app in a frame on its own origin, at `/nebula`, so `frameAncestors` stays `'self'`. It never runs the folder backend. The package exports what a host imports (`@starlove/nebula/app`, `/files`, `/backend`, `/backends/database`, `/bytes/store`, `/bytes/folder`, and the two `/conformance/…` modules), plus its `package.json`, which is how the host finds the built app (`dist/app`) beside it.

```js
import { Hono } from 'hono'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNebulaApp } from '@starlove/nebula/app'
import { signedOut } from '@starlove/nebula/files'

const nebulaRoot = dirname(fileURLToPath(import.meta.resolve('@starlove/nebula/package.json')))

const IDLE_MS = 15 * 60 * 1000
/** One Nebula per open workspace: its backend, its feeds. */
const open = new Map()

function nebulaFor(workspace) {
  let entry = open.get(workspace.id)
  if (!entry) {
    const app = createNebulaApp({
      basePath: '/nebula',
      assets: join(nebulaRoot, 'dist', 'app'),
      files: {
        backend: databaseBackend(workspace), // the Suite's, over cli/backend.mjs
        label: 'Starscape',
        allowHosts: ['suite.starscape.app'],
        homes: ['server'],
        scope: (request) => sessionOf(request).account.id,
        allowance: { bytes: workspace.plan.bytes, upgrade: '/billing' },
        resolve: (request) => {
          const session = sessionOf(request)
          if (!session || session.workspace.id !== workspace.id) return signedOut({ signIn: '/sign-in?next=/nebula' })
          return { actor: { type: session.agent ? 'agent' : 'human', id: session.account.id, name: session.account.name } }
        },
      },
    })
    entry = { app, used: Date.now() }
    open.set(workspace.id, entry)
  }
  entry.used = Date.now()
  return entry.app
}

setInterval(() => {
  for (const [id, entry] of open) {
    if (Date.now() - entry.used < IDLE_MS) continue
    entry.app.close()
    open.delete(id)
  }
}, 60_000).unref()

const suite = new Hono()

async function serveNebula(c) {
  const session = sessionOf(c.req.raw)
  if (!session) return c.redirect('/sign-in?next=/nebula')
  // @hono/node-server passes Node's request as c.env.incoming.
  const remoteAddress = c.env?.incoming?.socket?.remoteAddress
  return (await nebulaFor(session.workspace).fetch(c.req.raw, { remoteAddress })) ?? c.notFound()
}

suite.all('/nebula', serveNebula)
suite.all('/nebula/*', serveNebula)
```

`sessionOf`, `databaseBackend` and the workspace's plan are the Suite's. Its shell frames `/nebula/` (or `/nebula/p/<project>/<path>` to open a file), and Copy link in Nebula gives an address under `/nebula`.
