# Starscape Nebula

Nebula is a fancy Excalidraw shell for Starscape projects: an infinite sketching surface with Starscape chrome, local-first storage, multiple canvases per project, color modes, canvas text search, and Excalidraw library management.

It is built to feel like a clean visual-thinking room inside Orbit or any React host. Excalidraw owns the drawing engine; Nebula owns the project context, canvas switching, persistence boundary, themed shell, export/import flows, and library controls.

## What You Get

- Excalidraw drawing with shapes, arrows, text, freehand, images, selection, transforms, undo/redo, zoom, and pan.
- Multiple named canvases per board/project, persisted under the project context.
- Light and dark modes with rich Starscape backgrounds, plus plain white/black canvas-room modes.
- Search button that opens Excalidraw's native "find on canvas" panel for text in the scene.
- Export/import for `.excalidraw`, Nebula's wrapped JSON document, and Obsidian Excalidraw Markdown.
- Excalidraw Libraries with named collections, "add selection to library", download as `.excalidrawlib`, and a submission path for uploading to the shared Excalidraw libraries catalog.

## Install

Nebula now has two product paths:

- Hosted Nebula is for normal end users: open the URL, no install, no npm, and keep canvases in browser-local storage.
- Self-hosted Nebula CLI is for people who want local/private operation: install the package and run the browser-local app from your own machine.

The CLI starts as a launcher/static-server helper. It does not include Orbit's board engine, database, MCP server, or project daemon machinery.

## Hosted no-install app

Use the hosted Nebula URL when you just want the app. The hosted app still uses browser-local storage by default; there is no required account or backend persistence path in the MVP.

## Self-hosted CLI

Install or run the package locally, then start Nebula:

```sh
npm install -g @starlove/nebula
nebula run
```

`nebula run` serves the packaged local-first web app and prints the local URL. `nebula serve` is an alias for the same flow; it serves the built static app rather than starting an Orbit-style service.

Useful CLI commands:

```sh
nebula --help
nebula help
nebula -v
nebula --version
nebula run --port 4321
nebula serve
nebula init
```

`nebula init` currently validates the no-config posture and prints that no config is required. It should only create files if Nebula grows a real configuration need.

## React package install

```sh
pnpm add @starlove/nebula react react-dom
```

React and React DOM are peer dependencies. Excalidraw and the Starscape UI packages are installed through `@starlove/nebula`.

## Storage

By default Nebula uses browser `localStorage`, scoped by board and canvas. That makes it easy to drop into a project without a backend.

For host-owned persistence, pass a custom `SceneStore`:

```ts
import type { SceneStore } from '@starlove/nebula';

const store: SceneStore = {
  async load({ boardId, canvasId }) {
    return fetch(`/api/projects/${boardId}/canvases/${canvasId}`).then((r) =>
      r.ok ? r.json() : null,
    );
  },
  async save(document) {
    await fetch(`/api/projects/${document.boardId}/canvases/${document.canvasId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(document),
    });
  },
  async list(boardId) {
    return fetch(`/api/projects/${boardId}/canvases`).then((r) => r.json());
  },
};
```

Then pass `store` to `mountNebula` or `LazyNebulaExcalidrawShell`.

## Library Assets

Nebula adds named collections on top of Excalidraw's library system.

- Select shapes on the canvas and use `Add` to save them into a library.
- Switch between named libraries from the top-right library control.
- Save a library to `.excalidrawlib` when you want a portable asset pack.
- Use the shared-library submission action to open Excalidraw's public library guidelines and upload flow.

Libraries are stored per board in the browser unless your host provides its own persistence around Nebula documents.

## Local Development

```sh
pnpm install
pnpm dev
```

Useful checks:

```sh
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run build
pnpm run build:site
pnpm run build:cli-app
pnpm run build:lib
pnpm run build:package
pnpm run pack:dry-run
```

`pnpm run build` builds the standalone Vite app for local validation. `pnpm run build:site` builds the deployable marketing site into `dist/site`, with the local-first app mounted at `/app/`. `pnpm run dev:site` serves that Vercel-style site locally after rebuilding it. `pnpm run build:lib` builds the npm library package into `dist`. `pnpm run build:cli-app` adds the packaged static app at `dist/app`, and `pnpm run build:package` combines the library build with the CLI app build for npm packing.

## License

AGPL-3.0
