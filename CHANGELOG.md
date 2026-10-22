# Changelog

## 2.0.0, Files (2026-10-22)

Nebula becomes a workspace for a project's files.

- **Projects of real files**, kept in the browser's origin private file system (OPFS). Notes, Excalidraw canvases, images, PDFs, audio, video, text and code each open in a tab with their own view.
- **Around them:** a project switcher, an optional dock, a planet colour per project, a file tree (rename, move, delete, upload, star), ⌘K quick open by name, and Download for a file or a whole project as a `.zip`.
- **Notes** render from Markdown and edit in CodeMirror, as do text and code.
- **Canvases** are saved as `.excalidraw.md`, the format the Obsidian Excalidraw plugin writes. Plain `.excalidraw` files open and save too.
- **From 1.x:** canvases saved in `localStorage` are copied into projects on the first visit, one project per board, and the default board becomes "My First Project". The originals stay where they are, and old links open the file each canvas became.
- **Saves across tabs:** a save is written only over what its tab last saw, and in order. A change made in another tab shows as a conflict rather than being overwritten. A change that can't be written is kept as a copy beside the file, or offered as a download.
- **Settings:** night or day, a background for each (the sky or parchment, a colour, or an image of your own), Sheet or Pane, page width, note text (Mona Sans or Newsreader) and the dock.
- **The site** opens the app at `/` (old `/app` links redirect there), sends a Content-Security-Policy, and serves Excalidraw's fonts itself.
- **`nebula run`** serves the whole workspace from your machine. Projects made there live in that browser, for that address.
- **The React package's API is unchanged:** `mountNebula`, `LazyNebulaExcalidrawShell`, `SceneStore` and the rest work as in 1.x.
- **License:** AGPL-3.0. 1.0.0 stays MIT, as it was published.

## 1.0.0

The Excalidraw shell, with canvases per board in `localStorage`, libraries, themes and the `nebula` CLI.
