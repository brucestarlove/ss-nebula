# Changelog

## 2.0.1 (2026-11-15)

Notes link to everything now, and the editor draws what it says.

### Highlights

- **Links that work.** `[[Orion]]`, `[[Orion|the hunter]]`, `[[Orion#Stars]]` and `[[#Stars]]` open the file, or scroll to the heading. A link to a note that doesn't exist yet is muted, and a click makes it.
- **Embeds, in the page.** `![[picture.png]]` (with `|300` or `|300x200` for its size, or a caption), `![[Sketch.excalidraw]]` as a picture of the drawing, `![[Another note]]` (or one heading of it) in a quiet block, and PDFs, audio and video as cards or players. Pictures and drawings load as they scroll into view, and a drawing is drawn as an image, so nothing in it can run.
- **A live editor.** **Edit** now draws your Markdown as the page while you write: the line you're on shows its Markdown, and everything else is headings, quotes, lists, code and links. Task boxes tick with a click. Enter continues a list, Tab nests it, and Ctrl+B and Ctrl+I (⌘B, ⌘I) do bold and italic. The file stays plain Markdown. Notes over 200,000 characters still open as their source.
- **Type `[[` to link.** It offers your project's files, nearest first, and writes the shortest name that stays unique. `![[` offers what can be embedded, and `#` a note's headings.
- **Links and embeds in the editor too,** drawn as they are in the page. A **Live preview / Markdown source** switch beside the width switch (Ctrl+Shift+E, or ⌘⇧E) turns it all off and back on, keeping your place and your undo. Nebula remembers your choice on this device.
- **Links follow a rename.** Rename or move a file or folder and the links to it in your notes are rewritten, and the status line says how many. Nebula never touches a note with unsaved changes, one that changed meanwhile, a note over 200,000 characters or a canvas. It tells you which it left.

### Also

- **New folder** is in the Files heading and in the right-click menu on the blank space below your files.
- A browser that can't keep a project in a folder says which can: Chrome, Edge and Opera on a desktop.
- **Folders, safer.** Moving or renaming a folder copies each file, checks the copy and removes only what it copied. A drawing you change while **Move to a folder…** runs goes into the folder with the move. A rename that only changes case (`a.md` to `A.md`) works, and a move refuses names that differ only by case. Deleting in a folder project says it won't go to your computer's bin. The folder watcher looks at what changed, not the whole folder.
- Drawing previews carry Excalidraw's own fonts from Nebula's site, so the strict content policy stays as it was.

## 2.0.0 (2026-10-26)

Nebula 2.0 is a new Nebula: a calm home for everything a project is made of. Notes, canvases, images, PDFs, audio, video, text and code sit side by side in tabs, each with its own view, kept in your browser or in a folder on your computer. Your 1.x canvases come with you the first time you open it.

### Highlights

- **Projects of real files.** A note is a Markdown file, a canvas is an Excalidraw file, and anything you upload is stored as it is. Each opens in a tab with its own view.
- **Kept where you choose.** In your browser, with nothing to set up. Or in a folder on your computer (Chrome, Edge and Opera on desktop), as ordinary files that other apps, your agent and your backups can reach.
  - Changes made outside Nebula show up in it.
  - When the folder is out of reach, a drive unplugged, your edits wait and are saved once it's back.
  - **Move to a folder…** takes a browser project there.
- **Notes** read as a page. **Edit** (Ctrl+E, or ⌘E on a Mac) opens the Markdown, which saves as you type. Task boxes tick in place. Text and code files edit the same way. A note over 200,000 characters opens as its source, which stays quick, with **Read it** a click away.
- **Canvases** are Excalidraw, saved as `.excalidraw.md`, the format the Obsidian Excalidraw plugin writes. Plain `.excalidraw` files open and save too, and a canvas full of images saves in a fraction of the time.
- **Find your way.** A project switcher, a planet colour for each project and an optional dock. A file tree where you make folders, rename, move, delete, upload and star, with a right-click menu on any file, folder or blank space. **Search or jump to…** (Ctrl+K, or ⌘K) finds a file by its name.
- **Made to work beside Orbit and your agents.**
  - **Copy link** on a file, a folder or a tab gives the address that opens it, ready for an Orbit card. It opens where the project lives: in that browser, on that computer.
  - **Paste as note** turns your clipboard into a Markdown note, named for when you pasted it and its first heading (`2026-10-26 14.05 Deploy plan.md`). An agent's reply, kept apart from the agent.
  - A project in a folder is files your agent can read and write, and Nebula shows what it changes.
- **Image conversion, built in.** Right-click an image for **Convert image…**, or a folder for **Convert images…**. Choose WebP, JPEG or PNG, a quality and a longest side, then keep or replace the original.
  - It happens on your device and shows the result before writing it.
  - It never writes over another file.
  - It leaves out what the file carried besides the picture, like where a photo was taken.
  - Animated images stay as they are.
- **Calm to look at.** Night or day, each with its own background: the sky or parchment, a colour, or an image of your own. A page style, Sheet or Pane. A page width switch, Fixed or Stretch, on the note itself. Note text in Mona Sans or Newsreader.
- **A front door.** nebula.starscape.app is now a short page on what Nebula is and how to start. The app lives at **nebula.starscape.app/app**.
- **Open source again,** under the AGPL-3.0, as 1.x's code was.

### Coming from Nebula 1.x

Nothing to install. Open Nebula in the browser where you used 1.x:

- Each board becomes a project, and each canvas a file in it. Your default board becomes **My First Project**.
- Nebula copies your canvases and leaves the originals where they were.
- Old links still work: 1.x's `/b/…` addresses open the file each canvas became.
- A canvas that can't be moved stays behind, and the welcome note offers it as a download.

### What changed

- **Canvases are files,** in a project, instead of entries in the browser's `localStorage`.
- **The app moved to `/app`.** Older addresses at nebula.starscape.app still open it.
- **The licence:** 2.0 is AGPL-3.0. 1.0.0 on npm stays MIT, as it was published.
- **Run your own copy:** `nebula run` serves the whole app from your computer, on Node 20.19 or a later 20, or 22.12 and newer. Projects made there live in the browser that opens it, for that address.
- **For developers:** the React package's API is unchanged. `mountNebula`, `LazyNebulaExcalidrawShell`, `SceneStore` and the rest work as in 1.x.

### Safer

- **A strict content policy guards the page.** Nebula's fonts and code come from its own site, and nothing else loads on its own.
  - Web images in a note wait until you click **Load images**.
  - Web embeds in canvases, such as YouTube and Figma, are blocked.
  - Drawing libraries come only from libraries.excalidraw.com and raw.githubusercontent.com, when you add one.
- **Two tabs never overwrite each other.** A save replaces the whole file at once, and only over the version its tab last saw. If both tabs changed a file, you choose: **Reload** or **Keep mine**.
- **A save that can't be written isn't lost.** It's kept as a copy beside the file, or offered as a download.
- **In a folder,** Nebula checks whether another app changed a file just before it saves.
  - Moving or renaming a folder copies each file, checks the copy against the original and then removes only what it copied. It never deletes a folder wholesale.
  - A drawing you change while **Move to a folder…** runs goes into the folder with the move.
  - Renaming a file to the same name in a different case (`a.md` to `A.md`) works, and a move refuses a project whose names differ only by case, naming them.
  - Deleting in a folder project says it won't go to your computer's bin.

### Your data

- There's no account, and no Nebula server holds your files. Once the page has loaded, everything happens on your device: writing, drawing, converting and zipping. Nothing you make leaves your computer.
- **In your browser,** your files live in its private storage for that address. Browsers can clear what websites keep, so Nebula asks yours to keep them, and the rail says **May be cleared** until it agrees.
  - **Settings → Project → Download as .zip** keeps a copy, and Settings tells you when you last did.
  - Installed as an app, Nebula is cleared far less often.
- **In a folder,** they're ordinary files. Back the folder up as you would any other.
- Moving never deletes first: 1.x's canvases stay where they were, and **Move to a folder…** checks every file before it removes the browser's copy.

Before this release, Nebula 2.0 ran at nebula.starscape.app as two previews, numbered 2.0.0 and 2.1.0. Everything they brought is here.

## 1.0.0 (2026-06-03)

The first release: an Excalidraw shell, with canvases per board in the browser's `localStorage`, drawing libraries, themes and the `nebula` command.
