# Changelog

## 2.0.4 (2026-11-21)

A Nebula server remembers who changed each file and what it was, deleted files come back, and pictures become files of their own.

### Highlights

- **History, and Restore.** On a Nebula server that keeps projects in its database (Starscape hosting, and `nebula run --database`), the right panel's **History** lists a file's earlier versions: who saved each one, when, and how much it changed. **Preview** shows one (a note as a note, a canvas as its drawing, an image as itself), and **Restore** brings it back. The current version stays in History, and a file someone else changed meanwhile is never restored over. On a server that serves folders, History lists who changed the file and when, and says that the folder's own history, such as git or backups, is where earlier versions live.
- **History that stays small.** Nebula keeps each file's versions the way Time Machine does: one every 10 minutes for the last hour, one an hour for the last day, then one a day for 14 days. The version just before another person or agent saved, and the one before a delete, are always kept. A save that changes nothing stores nothing. Ten thousand saves to one note leave about 40 versions.
- **"Edited by Docu, 5 min ago".** On a Nebula server, every file says who last changed it, and "you" for your own changes, in the note's line and in the status line for every other kind of file. In the browser or a folder you picked there is only you, so the line reads "Edited 5 min ago".
- **Pictures as files.** An image pasted or dropped onto a canvas, or into a note while you edit it, is saved as its own file in `Attachments/` (`Pasted image 20261121014500.png`, or its own name when dropped). The canvas names it the way Obsidian Excalidraw does, and the note gets `![[…]]` where your cursor is. A canvas then saves only its drawing, the picture shows in the files, and the same folder opens in Obsidian. Renaming the picture updates the canvases that use it. **Download as .excalidraw** puts the pictures back inside, so the file stands alone. **Move images to files**, on a canvas or a whole project, does the same for drawings made before, copying first and deleting nothing.
- **Deleted files come back,** on a Nebula server that keeps history (Starscape hosting, and `nebula run --database`). **Recently deleted**, in Settings, lists the open project's files deleted in the last 14 days, a deleted folder's files one by one with their folder, and **Restore** brings one back to its path, never over a file that is there now. The delete dialog says so on such a server. Elsewhere a deleted file is still gone for good.
- **Deleting a project can be undone** on a Nebula server's database: **Recently deleted**, in Settings, restores it for 14 days.

### Also

- **`nebula run --help` and `nebula serve --help`** print the help, as `nebula help` does.
- **The reading view selects and copies,** by dragging, double-clicking or Ctrl+A (⌘A). The rest of the window stays out of the selection.
- **Tags look like links,** the same in the page, in the editor and in the Markdown source, and a click on one searches for it. The source switch beside Edit now shows `</>`.
- **Read or edit is remembered.** Switch a note to editing, and the next one you open is ready to edit. Switch back, and they open to read.
- **Deleting a file others refer to says so first,** listing them under **Referenced by**: the notes that link to it and the canvases that use it, the first five and how many more.
- **For hosts.** A host can set how much space an account has (`allowance`): a save past it is refused with the numbers and an upgrade link, and Settings shows the space used. A host whose session has ended answers with `signedOut()` (its message can run to 300 characters), and the app keeps every unsaved edit until the person signs in again. In a frame, the app and its host talk through a small set of messages (shown or hidden, open a file, shortcuts, sign in), and a hidden Nebula lets go of its live connection. A file opened from an Orbit card names the card on every save. A backend that keeps history says so with `capabilities.deletedFiles` and answers `GET <api>/projects/<id>/deleted`; a restore into a path another file has taken answers 412. The rules every backend keeps, History's among them, ship as `@starlove/nebula/conformance/backend` and `/conformance/bytes`, for a host's own storage to pass. `docs/hosting.md` covers all of it.

### Breaking

- **The database moves to schema 2** the first time 2.0.4 opens it, after a whole copy of it beside itself (`nebula.db.schema1-<date>.bak`). Nebula 2.0.3 then opens it read-only.
- **On the database backend, a save identical to the file adds no version** and no entry to the change log.
- **The package exports paths for hosts** (`./app`, `./files`, `./backend`, `./backends/database`, `./bytes/store`, `./bytes/folder` and the two conformance modules); a host's `import.meta.resolve` workaround can become a plain import.

## 2.0.3 (2026-11-21)

Nebula becomes an app you can host: one server, any address, three ways to keep projects.

### Highlights

- **Every change says who made it.** A Nebula server records each write, new folder, rename and delete with when it happened, who made it (a person or an agent, named) and, when the writer gives one, what it was for (an Orbit card's link). `GET <api>/changes` lists them across projects, newest first, and a file's listing names who last wrote it.
- **Projects in a database.** `nebula run --database <folder>` keeps projects in one SQLite file, with each file's contents beside it. History survives restarts, a folder of thousands of files renames at once, and a deleted or replaced file can be brought back for 14 days. New project makes a project there. Needs Node 22.13 or later; folders still run on Node 20.
- **Nebula under any address.** A server can mount the whole app, its page, its files and its API, under a path such as `/nebula`, and choose which places it offers: only its own, for a host shared by several accounts. `docs/hosting.md` shows how.
- **One install, nothing to resolve.** `npm install -g @starlove/nebula` and `npx @starlove/nebula run` install the app and its CLI with no dependencies, in seconds, on npm 10 and 11.

### Breaking

- **`@starlove/nebula` is the app and its CLI, not a library.** The React library (`mountNebula`, `LazyNebulaExcalidrawShell`, the `localStorage` scene store) and the Orbit adapter are gone.
- **Nebula 1.x's canvases are no longer moved in.** Their keys stay in the browser, untouched; 1.x's `/b/…` links open the app.
- **`vercel.json` is `routes.json`**, the one source of routes and headers for every server.
- **The server tier's mark** is `Server-Timing: nebula-files;desc="<api base>"` (it was `desc="1"`), and a project made by a server records that server's person as `createdBy` (it was `nebula-server`).

### Also

- The canvas keeps only its own look: 1.x's whole interface, which had lived on unseen inside it, is gone, and the first load carries about 50 KB less CSS.
- New project wraps its choices rather than overflow when a server can make projects too.
- An upload over the server's size limit is refused at once, without sending the rest.

## 2.0.2 (2026-11-17)

Find anything you wrote or drew, see what links where, and serve your own folders.

### Highlights

- **Search inside your notes and drawings.** **Search or jump to…** (Ctrl+K, or ⌘K) now finds the words in your notes and the words drawn on your canvases, as well as file names. Pick a result and the note opens at that line. Search ignores case and accents, and `#tag` finds what carries a tag.
- **Linked from.** The right panel lists every note and canvas that links to the file you have open, whatever kind it is, with the line each link sits on. **Not linked yet** lists the notes that name it without a link.
- **Tags.** `#tags` in a note, and `tags:` in its front matter, are now buttons that search for the tag. The panel lists the open note's tags and every tag in the project, with nested tags (`#project/nebula`) under their parent.
- **Links in drawings.** Write `[[Orion]]` in a canvas's text and it becomes a link, as in Obsidian Excalidraw: click its icon and the note opens in a tab.
- **The outline follows you.** It marks the heading you're reading, keeps it in view, and works while you edit: a click moves the cursor there.
- **Folders on a machine you run.** `nebula run --project <folder>` or `--projects <folder>` serves real folders as projects, and the app lists them beside your browser's, in any browser. Changes other apps and agents make show up as they land, usually in a fraction of a second; when the machine is out of reach, your edits wait and are saved once it's back. The server answers only its own page: other sites, and names it doesn't serve, are refused.

### Also

- **Tables are drawn as tables** in the editor. Click a cell to edit its Markdown; a wide table scrolls on its own.
- **Pictures and drawings keep their place** while they load, in the page and in the editor, so nothing below them jumps.
- **The editor reads well with a screen reader:** headings keep their level, task boxes say whether they're done, links and embeds are named, and Escape leaves the editor for the note's toolbar.
- **Convert images** now updates the links to a picture it replaces, as a rename does.
- **On a server:** big folders, `.git` and `node_modules` cost the server almost nothing to watch; disks without hard links (exFAT, some network drives) work; a read-only, full or locked disk says so instead of "can't reach".

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
