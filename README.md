# Starscape Nebula

Nebula is a workspace for notes, drawings and media, kept in projects in your browser or in a folder on your computer. A project is a folder of real files: Markdown notes, Excalidraw canvases, images, PDFs, audio, video, text and code, each opening in a tab with its own view. There is no account: the files stay on your device, or on a machine you run.

[nebula.starscape.app](https://nebula.starscape.app) says what it is; the app runs at [nebula.starscape.app/app](https://nebula.starscape.app/app). Nebula is an app, not a library: the site, and `nebula run`, which serves the same app, and optionally your own folders, from your machine.

## What you get

- **Projects** with a switcher, an optional dock, and a planet colour each. A first visit opens Night Sky, a small sample project, under a welcome.
- **Files:** a tree with folders, inline rename, drag to move, delete, upload, star, and ⌘K quick open by name. Download a file, or a whole project as a `.zip`.
- **Notes** render from Markdown (task boxes tick in place) and edit in CodeMirror; text and code open in CodeMirror too.
- **Canvases** are Excalidraw drawings saved as `.excalidraw.md`, the format the Obsidian Excalidraw plugin writes; plain `.excalidraw` files open and save too. Excalidraw libraries work as before, with named collections.
- **Images, PDFs, audio and video** open in their own views; anything else gets an info card with Download.
- **Image conversion:** right-click an image, or a folder of them, for *Convert image…*: WebP, JPEG or PNG, a smaller longest side, keep or replace the original. It runs on the device.
- **Paste as note:** right-click a folder (or New) for *Paste as note*, and the clipboard's text becomes a Markdown note named for when it was pasted, plus its first heading: `2026-10-26 14.05 Deploy plan.md`. Made for keeping an agent's replies.
- **Copy link:** right-click a file, a folder or a tab for *Copy link*, the address that opens it (`/app/p/<project>/<path>`), for an Orbit card or a note. A folder's link opens the folder in the files. It opens where the project lives: in that browser, on that computer.
- **Folder projects** (Chrome, Edge and Opera on desktop): open a folder on your computer as a project, make a new project in one, or move a browser project there.
- **Settings:** night or day (or the system's), the page style (Sheet or Pane), page width, note text (Mona Sans or Newsreader) and the dock. They survive a reload.
- **Phones:** a top bar, a thumb bar and the files as a sheet.

## Run it

```sh
pnpm install
pnpm dev
```

Then open the URL Vite prints. Node 20.19+ or 22.12+ and pnpm 10.

## Where your files live

In the browser's origin private file system (OPFS), under `nebula/`:

- `nebula/registry.json` lists the projects;
- `nebula/projects/<folder>/` holds each project's files, with its name and colour in `.nebula/project.json` and what was open in `.nebula/workspace.json`.

Nebula asks the browser to keep them (persistent storage) after your first edit. A browser that can't keep files here (a private window, for one) runs Nebula in memory and says so: everything is gone when the tab closes, unless you download it.

**Or in a folder on your computer** (Chrome, Edge and Opera on desktop, through the File System Access API): a folder project's files are the folder's own, and the browser remembers only the permission to reach it.

**Or in folders on a machine you run** (the server tier, any browser): `nebula run --projects <folder>` serves every folder in it as a project, and the app it serves lists them beside the browser's own. Nebula reads and writes their files there and shows changes other apps and agents make as they land.

**From Nebula 1.x:** canvases it saved in `localStorage` (`nebula:excalidraw:<board>:<canvas>`) aren't read any more, and neither are its older library keys. Nebula never deletes them: they stay in that browser until you clear them. An old link (`/b/<board>/c/<canvas>`) lands on the app's front door.

A file's or folder's own address is `/app/p/<project>/<path>` on the site (`/p/<project>/<path>` where the app is served at the root, as `pnpm dev` and `nebula run` do); `/p/…` links on the site redirect into `/app`.

## Security headers

`routes.json` sends a Content-Security-Policy with every response, and `serve-site.mjs` sends the same headers locally, so the end-to-end suite runs under it. Nothing a project holds can reach another site, and opening a note or a canvas contacts no one: Excalidraw's fonts come from this site (`/fonts/`, copied from the package into every build) rather than esm.sh.

| Directive | Allows | Why |
|---|---|---|
| `default-src` | `'self'` | Everything else comes from this site. |
| `script-src` | `'self'`, one `sha256-` hash, `'wasm-unsafe-eval'` | The hash is the app page's inline script (`index.html`, served as `/app`), which applies the saved theme before first paint (`tests/nebulaSite.test.mjs` checks it matches). The landing page has no inline script. WebAssembly is how Excalidraw subsets fonts when it exports. No `eval`. |
| `style-src` | `'self'`, `'unsafe-inline'` | Excalidraw's *Mermaid to Excalidraw* lays out the diagram with `<style>` elements and style attributes; with them blocked, its boxes and labels come out the wrong size (measured: 102 blocked, every shape off). Its SVG export also sets style attributes. A hash for the splash's `<style>` would switch `'unsafe-inline'` off, so there is none. |
| `img-src` | `'self'`, `data:`, `blob:`, `https:` | Excalidraw keeps images as `data:` URLs, the image view shows a file through a `blob:` URL, and the stylesheets use `data:` icons. `https:` is for web images in notes, which the note view loads only when its reader clicks Load images, so a note can't carry a tracking pixel. |
| `media-src` | `'self'`, `blob:` | Audio and video play from `blob:` URLs of their files. |
| `frame-src` | `blob:` | The PDF view frames the file's `blob:` URL, which the browser's viewer opens. Excalidraw's web embeds (YouTube, Figma and the like) are blocked. |
| `worker-src` | `'self'`, `blob:` | Excalidraw's font-subsetting worker is a file of this site; its image resizer (pica) starts workers from `blob:` URLs. |
| `connect-src` | `'self'`, `https://libraries.excalidraw.com`, `https://raw.githubusercontent.com` | The sample's image and PDF come from this site; the two hosts are the only ones the canvas accepts an Excalidraw library from (`#addLibrary=` links). |
| `font-src` | `'self'` | Nebula's own fonts and Excalidraw's, all served here. |
| `object-src` | `'none'` | No plugins. Chromium's PDF viewer still works in the PDF view (checked in full Chromium). |
| `base-uri`, `form-action`, `frame-ancestors` | `'self'` | No `<base>` or form posting elsewhere, and no framing by other sites. |

## Checks

```sh
pnpm run verify          # typecheck, unit tests, build, lint
pnpm run build:site      # the deployable site in dist/site, plus dist/site-chunks.json
```

The end-to-end suite runs on the production build, served by `serve-site.mjs` with `routes.json`'s routing and headers, in Chromium and WebKit:

```sh
NEBULA_E2E_BUILT=1 pnpm exec playwright test --project=chromium e2e/app-
NEBULA_E2E_BUILT=1 pnpm exec playwright test --project=webkit e2e/app-
```

Each test gets a fresh browser profile (WebKit keeps OPFS only in a persistent one) and fails if the policy blocks anything or a request leaves the site. `e2e/app-budget.spec.ts` checks the first load against `dist/site-chunks.json`: Excalidraw, CodeMirror, react-markdown and the sample each load only when a visit needs them. Tests marked fixme wait on bugs in another lane's code; `NEBULA_E2E_FIXME=1` runs them anyway.

Without `NEBULA_E2E_BUILT`, Playwright starts the dev server for the lane specs (`e2e/files-*`, `shell-*`, `views-*`), whose harness pages live in `e2e/harness/`. `NEBULA_E2E_PORT` picks the port.

## Self-hosted CLI

From npm (`@starlove/nebula` is the app and its CLI; 1.x was a canvas library, which 2.x no longer ships):

```sh
npm install -g @starlove/nebula
nebula run
```

or without installing:

```sh
npx @starlove/nebula run
```

The package has no dependencies: the app is built into it, and the CLI uses only Node's own modules (Node 20.19+ or 22.12+).

From a checkout:

```sh
pnpm install
pnpm run build:package
node bin/nebula.mjs run
```

`nebula run` (or `nebula serve`) serves the packaged app from your own machine and prints the local URL; `nebula run --port 4321` picks the port. `nebula init` checks there's nothing to configure.

With folders it serves them too, as projects:

```sh
nebula run --project ~/Notes                 # one folder, one project
nebula run --projects ~/Work --label studio  # every folder inside ~/Work
```

Or it keeps the projects itself, in a database (Node 22.13 or later, for `node:sqlite`):

```sh
nebula run --database ~/nebula-data          # nebula.db and bytes/ in that folder, made if new
```

The tree and every change's history are in `nebula.db`, the files' contents in `bytes/`, and New project in the app makes projects there. They survive a restart, and so does each change's record of who made it and when. A server does one or the other: `--database` isn't taken with `--project` or `--projects`.

It answers only loopback names (`127.0.0.1`, `localhost`) unless told another with `--allow-host <name>` (a tailnet name behind `tailscale serve`), and refuses requests from other sites. It has no accounts: keep it on your own machine or a private network. No Orbit board engine or daemon.

Without `--project`, `--projects` or `--database`, projects made there live in the browser that opens it, for that address: the ones at `http://127.0.0.1:4321` aren't the ones at nebula.starscape.app. Download a project as a `.zip` to move it.

What changed in each version: [CHANGELOG.md](CHANGELOG.md).

## Builds

`pnpm run build` builds the standalone app for local checks. `pnpm run build:site` builds the deployable site into `dist/site`: the landing page (`site/`) at `/` and the app at `/app` (`app.html`), with `routes.json` sending 2.0's `/p/…` links, and 1.x's `/b/…` links, into the app. `pnpm run build:landing` rebuilds the landing alone, and `pnpm run dev:site` serves the site locally with the same routing and headers. The landing's pictures of the app are made from a demo project (`site/demo/`) by `site/shots/capture.mjs` (against `pnpm dev`) and `site/shots/encode.py`; remake them whenever the app's look changes. `pnpm run build:package` builds the packaged app into `dist/app`, the only thing besides `bin/` and `cli/` the npm package carries (`pnpm run pack:dry-run` to check).

## Licence

Open source under the GNU Affero General Public License 3.0 ([LICENSE](LICENSE)), © 2026 Starscape LLC, as 1.x's code was. 1.0.0 on npm stays MIT, as it was published. Nebula is built with open-source libraries, each under its own licence (the site lists them at `/third-party-licenses.txt`).
