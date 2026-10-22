import { errorName, type FileChangedError } from '../../../files/errors';
import { isInside } from '../../../files/paths';
import type { FileChange, FileEntry, FileStore } from '../../../files/types';
import { createEmptyNebulaMetadata } from '../../../nebula/excalidraw/metadata';
import { readObsidianExcalidrawMarkdown, updateObsidianExcalidrawMarkdown } from '../../../nebula/excalidraw/obsidianMarkdown';
import {
  createEmptyExcalidrawScene,
  isExcalidrawScene,
  normalizeExcalidrawScene,
  type ExcalidrawElementLike,
  type ExcalidrawScene,
} from '../../../nebula/excalidraw/scene';
import {
  isNebulaExcalidrawDocument,
  NEBULA_EXCALIDRAW_DOCUMENT_TYPE,
  NEBULA_EXCALIDRAW_DOCUMENT_VERSION,
  type CanvasSummary,
  type NebulaExcalidrawDocument,
  type SceneStore,
  type SceneStoreRef,
} from '../../../nebula/storage/types';
import { conflictCopyName, writeConflictCopy } from '../shared/conflictCopy';
import { heldHere, openFileSession, reportKeptCopy, writeAllowed, writesSettled, type OpenFileSession, type SessionScope } from '../shared/fileSessions';
import { titleFromName } from '../shared/format';
import { withoutRemoteFiles, type SceneFiles } from './sceneFiles';

/**
 * A SceneStore over one canvas file (docs/slice-3.md, decision 1):
 *
 * - `.excalidraw.md` is read with readObsidianExcalidrawMarkdown and written
 *   with toObsidianExcalidrawMarkdown(scene, { compressed: true });
 * - `.excalidraw` is Excalidraw's JSON;
 * - a plain `.md` drawing reads like `.excalidraw.md` and is written back in
 *   that format;
 * - an empty file opens as an empty canvas.
 *
 * Opening never writes: the first save after load is Excalidraw's echo of the
 * scene as it opened, and only a change to the elements or their images
 * (not a pan, a zoom or a selection) is written. Saves coalesce while drawing,
 * at most one write per `intervalMs`, and flush() writes at once.
 */
export type FileSceneState = {
  /** A change is waiting to be written, or being written. */
  pending: boolean;
  /** Elements on the canvas (deleted ones don't count); null before load. */
  elementCount: number | null;
  /** The view's zoom, 1 at 100%. Never written for its own sake. */
  zoom: number;
  /** Why the last write failed; cleared by the next good one. */
  error?: unknown;
  /** Changed elsewhere while this canvas had unsaved changes: waiting for
   * reload() or keepMine(); nothing is written until then. */
  conflict: boolean;
  /** Deleted elsewhere: nothing more is written. */
  removed: boolean;
  /** Counts the times the scene was replaced from the file (a change made
   * elsewhere, or Reload): the canvas remounts to show it. */
  revision: number;
};

export type FileSceneStore = SceneStore & {
  getState(): FileSceneState;
  subscribe(listener: () => void): () => void;
  /** Writes the pending change now. */
  flush(): Promise<void>;
  /** Flushes and stops following the file. */
  dispose(): Promise<void>;
  /** "Reload": drop unsaved changes and take the file as it is now. */
  reload(): Promise<void>;
  /** "Keep mine": write this canvas over the change made elsewhere. */
  keepMine(): Promise<void>;
};

export type FileSceneStoreOptions = {
  store: FileStore;
  path: string;
  /** At most one write per this many milliseconds while drawing. */
  intervalMs?: number;
  /** Which project the file belongs to (its id), so sessions of the same
   * file, and the workspace's renames and deletes, find each other. Defaults
   * to the store. */
  scope?: SessionScope;
  /** Writes a scene as the file's text; `serialize` below unless a test
   * looks at what it's handed. */
  serialize?: (original: string | null, scene: ExcalidrawScene, format: CanvasFormat) => string;
};

export const CANVAS_SAVE_INTERVAL_MS = 400;

type Format = 'json' | 'markdown';

function formatOf(path: string): Format {
  return path.toLowerCase().endsWith('.excalidraw') ? 'json' : 'markdown';
}

function nameOf(path: string): string {
  return titleFromName(path.slice(path.lastIndexOf('/') + 1));
}

function readScene(text: string, format: Format): ExcalidrawScene {
  if (!text.trim()) return createEmptyExcalidrawScene();
  if (format === 'markdown') return readObsidianExcalidrawMarkdown(text);
  const parsed: unknown = JSON.parse(text);
  if (isNebulaExcalidrawDocument(parsed)) return normalizeExcalidrawScene(parsed.scene);
  if (!isExcalidrawScene(parsed)) throw new Error('This file is not an Excalidraw drawing.');
  return normalizeExcalidrawScene(parsed);
}

/** A file's drawing as it may reach Excalidraw: only `data:` images
 * (re-review R2). `held` is the rest, which a save puts back. */
function parseFile(text: string, format: Format): { scene: ExcalidrawScene; held: SceneFiles } {
  return withoutRemoteFiles(readScene(text, format));
}

function parseScene(text: string, format: Format): ExcalidrawScene {
  return parseFile(text, format).scene;
}

function liveElements(scene: ExcalidrawScene): ExcalidrawElementLike[] {
  return scene.elements.filter((element) => !element.isDeleted);
}

/** The scene as it belongs in a file: no deleted elements, only the images
 * the remaining elements use. */
function forFile(scene: ExcalidrawScene): ExcalidrawScene {
  const elements = liveElements(scene);
  const used = new Set(elements.map((element) => element.fileId).filter((id): id is string => typeof id === 'string'));
  const files = Object.fromEntries(Object.entries(scene.files ?? {}).filter(([id]) => used.has(id)));
  return { ...normalizeExcalidrawScene(scene), elements, files };
}

const EXPORTED_APP_STATE = ['gridSize', 'gridStep', 'gridModeEnabled', 'viewBackgroundColor'];

export type CanvasFormat = Format;

/**
 * Every write of a canvas goes through here, and only here. A markdown
 * drawing keeps everything in its file that isn't the drawing (review
 * finding 8): frontmatter, the notes above `# Excalidraw Data`, Element
 * Links, Embedded Files, and the drawing's encoding (the plugin's setting).
 * A new or empty file is written compressed.
 *
 * `original` is the file's text as it is now: as opened, then as last
 * written, reloaded or taken from elsewhere; null when there's none. `format`
 * is 'json' for an `.excalidraw` file, which is Excalidraw's JSON.
 */
export function serialize(original: string | null, scene: ExcalidrawScene, format: CanvasFormat = 'markdown'): string {
  const clean = forFile(scene);
  if (format === 'markdown') return updateObsidianExcalidrawMarkdown(original ?? '', clean);
  const appState: Record<string, unknown> = {};
  for (const key of EXPORTED_APP_STATE) if (clean.appState && key in clean.appState) appState[key] = clean.appState[key];
  // Nebula draws on a transparent canvas so the sky shows; elsewhere that
  // would paint black, so files keep Excalidraw's white.
  if (!appState.viewBackgroundColor || appState.viewBackgroundColor === 'transparent') appState.viewBackgroundColor = '#ffffff';
  return JSON.stringify({ type: 'excalidraw', version: 2, source: clean.source, elements: clean.elements, appState, files: clean.files }, null, 2);
}

/** Where the canvas was looking: kept across a reload, since the shell
 * remounts to show a drawing taken from elsewhere. */
function viewOf(scene: ExcalidrawScene): Record<string, unknown> | null {
  const { scrollX, scrollY, zoom } = (scene.appState ?? {}) as Record<string, unknown>;
  if (!Number.isFinite(scrollX) || !Number.isFinite(scrollY)) return null;
  return { scrollX, scrollY, ...(zoom && typeof zoom === 'object' ? { zoom } : {}) };
}

function zoomOf(scene: ExcalidrawScene): number {
  const zoom = (scene.appState as { zoom?: { value?: unknown } } | undefined)?.zoom?.value;
  return typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

/** The view settings a file keeps, as they're written (review finding 21):
 * the grid, and the canvas colour, where Nebula's see-through canvas is
 * written as white. Pans, zooms and selections aren't among them. */
function keptAppState(scene: ExcalidrawScene): string {
  const appState = (scene.appState ?? {}) as Record<string, unknown>;
  const background = appState.viewBackgroundColor;
  return JSON.stringify([
    appState.gridSize ?? null,
    appState.gridStep ?? 5,
    appState.gridModeEnabled ?? false,
    !background || background === 'transparent' ? '#ffffff' : background,
  ]);
}

/** What makes a save worth writing: the elements' versions, the images,
 * and the view settings the file keeps. */
function signatureOf(scene: ExcalidrawScene): string {
  const elements = scene.elements.map((element) => `${element.id}:${String(element.version ?? '')}:${element.isDeleted ? 1 : 0}`);
  return `${elements.join(',')}|${Object.keys(scene.files ?? {}).sort().join(',')}|${keptAppState(scene)}`;
}

/** What the file holds, for telling a real change from the same drawing in
 * other bytes: the live elements and the images they use. */
function fileSignatureOf(scene: ExcalidrawScene): string {
  return signatureOf(forFile(scene));
}

export function createFileSceneStore({
  store,
  path: initialPath,
  intervalMs = CANVAS_SAVE_INTERVAL_MS,
  scope = store,
  serialize: write = serialize,
}: FileSceneStoreOptions): FileSceneStore {
  let path = initialPath;
  let state: FileSceneState = { pending: false, elementCount: null, zoom: 1, conflict: false, removed: false, revision: 0 };
  /** Where the canvas was last looking (scroll and zoom), from its saves. */
  let lastView: Record<string, unknown> | null = null;
  let loading: Promise<NebulaExcalidrawDocument> | null = null;
  let loaded = false;
  let removed = false;
  /** Removed by another tab (not by this one, nor with its project): this
   * canvas's own pending change is kept, and written beside where the file
   * was when the view goes (round 4, F5). */
  let deletedElsewhere = false;
  /** dispose() has begun: nothing new is taken, but renames and deletes are
   * followed until the last write is done. */
  let closing = false;
  /** The signature on disk (or the scene as it opened). */
  let savedSignature: string | null = null;
  /** The file's text as this store last read or wrote it (what serialize()
   * gets as `original`), and the drawing it holds. */
  let savedText: string | null = null;
  let fileSignature: string | null = null;
  /** The text being written right now, so its echo isn't taken for a change. */
  let inFlight: string | null = null;
  /** The text a write put at the path the canvas was renamed from, which
   * the rename may have carried to where it is now: its own, too. Only an
   * optimisation since round 5: every write expects the exact text its check
   * accepted, so a mistake here can only show a conflict, never overwrite. */
  let carriedText: string | null = null;
  /** The file's text when a conflict began: Keep mine writes over that, and
   * a change landing after it is asked about again. */
  let theirsText: string | null = null;
  /** A write found the file gone (moved or deleted elsewhere) before this
   * canvas heard of it: the change waits for the rename (or the delete). */
  let awaitingMove = false;
  /** Saves are numbered (round 5, G1, G2): `latestSeq` is the newest the
   * canvas reported, `pendingSeq` the pending scene's, `takenSeq` the newest
   * a write has taken, `writtenSeq` the newest on disk. */
  let latestSeq = 0;
  let pendingSeq = 0;
  let takenSeq = 0;
  let writtenSeq = 0;
  /** Reload dropped every save up to this one: a write still queued for one
   * of them is never made. */
  let droppedSeq = 0;
  /** The file's size and time when this store last read or wrote it; null
   * when it doesn't know. */
  let seen: Pick<FileEntry, 'size' | 'modified'> | null = null;
  let pendingScene: ExcalidrawScene | null = null;
  /** Images the file holds that aren't given to Excalidraw (not `data:`,
   * re-review R2): every write puts them back, so the file keeps them. */
  let held: SceneFiles = {};
  /** The newest scene the canvas reported, for Keep mine. */
  let latestScene: ExcalidrawScene | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Every write, one after another; it never rejects. */
  let writing: Promise<void> = Promise.resolve();
  let checking: Promise<void> = Promise.resolve();
  let writes = 0;
  const listeners = new Set<() => void>();

  const session: OpenFileSession = {
    scope,
    path: () => path,
    flush: () => flush(),
    idle: () => writing,
    unsaved: () => state.pending,
  };
  const handle = openFileSession(session);

  const update = (patch: Partial<FileSceneState>) => {
    const keys = Object.keys(patch) as Array<keyof FileSceneState>;
    if (keys.every((key) => Object.is(state[key], patch[key]))) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
    handle.changed();
  };

  const settlePending = () => {
    const pending = pendingScene !== null || writes > 0;
    if (pending !== state.pending) update({ pending });
  };

  const cancelTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  /** The file as written: the scene, with the images held back put back. */
  const fileText = (original: string | null, scene: ExcalidrawScene, format: Format) =>
    write(original, Object.keys(held).length ? { ...scene, files: { ...held, ...scene.files } } : scene, format);

  /** The file as it is now becomes the canvas: the shell remounts and loads it. */
  const takeFile = (text: string, { scene, held: kept }: { scene: ExcalidrawScene; held: SceneFiles }) => {
    held = kept;
    savedText = text;
    seen = null;
    fileSignature = fileSignatureOf(scene);
    savedSignature = null;
    loading = null;
    // Until the canvas loads it, saves from the old canvas are ignored.
    loaded = false;
    carriedText = null;
    theirsText = null;
    update({ revision: state.revision + 1, elementCount: liveElements(scene).length, conflict: false });
  };

  /** Changed elsewhere while this canvas has a change of its own: ask.
   * `theirs` is the file's text as found, or null when it isn't known. */
  const startConflict = (theirs: string | null) => {
    theirsText = theirs;
    // What was carried belongs to before the conflict (G6).
    carriedText = null;
    cancelTimer();
    update({ conflict: true });
  };

  /** A write that didn't land gives its scene back, unless a newer one is
   * pending or was taken by a later write since: that one carries the newer
   * drawing, and an older scene must never come back after it (round 5,
   * G1, G2). */
  const restore = (scene: ExcalidrawScene, seq: number) => {
    if (pendingScene !== null || seq < takenSeq) return;
    pendingScene = scene;
    pendingSeq = seq;
  };

  /** A write to this file: an echo of this store's own save, the same
   * drawing in other bytes, or a change made elsewhere, taken at once when
   * nothing here is unsaved and otherwise held for Reload or Keep mine. */
  const checkFile = async () => {
    await writing;
    if (closing || removed || !loaded) return;
    let text: string;
    let parsed: { scene: ExcalidrawScene; held: SceneFiles };
    try {
      text = await store.readText(path);
      if (text === savedText || text === inFlight || text === carriedText) return;
      parsed = parseFile(text, formatOf(path));
    } catch {
      // Unreadable or not a drawing (yet): the next good write is checked.
      return;
    }
    if (closing || removed) return;
    if (fileSignatureOf(parsed.scene) === fileSignature) {
      savedText = text;
      seen = null;
      return;
    }
    if (pendingScene === null && writes === 0 && !state.conflict) {
      takeFile(text, parsed);
      return;
    }
    startConflict(text);
  };

  const unwatch = store.watch((change: FileChange) => {
    // The file itself, or a folder above it.
    if (change.type === 'rename' && isInside(path, change.from)) {
      path = change.to + path.slice(change.from.length);
      // A write that found the file gone was waiting for this.
      if (awaitingMove) {
        awaitingMove = false;
        void writeNow();
      }
    }
    if (change.type === 'write' && change.path === path) checking = checking.then(checkFile, checkFile);
    if (change.type === 'remove' && (change.path === '' || isInside(path, change.path))) {
      removed = true;
      // A delete made here holds this session's writes, and means to drop
      // the change; so does the project going.
      deletedElsewhere = change.path !== '' && !heldHere(scope, path);
      if (!deletedElsewhere) pendingScene = null;
      cancelTimer();
      settlePending();
      update({ removed: true, conflict: false });
    }
  });

  /** Whether the file is still what this canvas last saw. Another tab's save
   * can land before its message does, and a write now would silently undo
   * it (review finding 3). Cheap when nothing changed: one stat. */
  const fileUnchanged = async (target: string): Promise<'same' | 'changed' | 'gone'> => {
    let now: FileEntry | null;
    try {
      now = await store.stat(target);
    } catch {
      return 'same';
    }
    // Gone: deleted or moved elsewhere, and not heard about yet.
    if (now === null) return 'gone';
    if (seen && now.size === seen.size && now.modified === seen.modified) return 'same';
    let text: string;
    try {
      text = await store.readText(target);
    } catch {
      return 'same';
    }
    let same = text === savedText || (carriedText !== null && text === carriedText);
    if (!same) {
      try {
        same = fileSignatureOf(parseScene(text, formatOf(target))) === fileSignature;
      } catch {
        same = false;
      }
    }
    if (same) {
      savedText = text;
      seen = now;
    } else theirsText = text;
    return same ? 'same' : 'changed';
  };

  /** A write that found the file deleted by another tab keeps its scene. */
  const keepIfDeletedElsewhere = (scene: ExcalidrawScene, seq: number) => {
    if (deletedElsewhere) restore(scene, seq);
  };

  /** One write, decided when its turn comes: where the canvas is then, and
   * nothing at all once it's deleted or changed elsewhere. It writes only
   * over the text its check accepted (round 5): a save landing from another
   * tab after the check is refused under the write's own lock and asked
   * about, never overwritten. */
  const writeScene = async (scene: ExcalidrawScene, signature: string, seq: number): Promise<void> => {
    try {
      // A rename, move or delete in this workspace holds writes until it's done.
      await writeAllowed(scope, () => path);
      // A newer drawing is on disk already: never put an older one back
      // (G1). Nor one that Reload dropped.
      if (seq < writtenSeq || seq <= droppedSeq) return;
      for (let attempt = 1; ; attempt += 1) {
        if (removed) {
          keepIfDeletedElsewhere(scene, seq);
          return;
        }
        if (state.conflict) {
          restore(scene, seq);
          return;
        }
        const target = path;
        // Serialised before the check, so little time passes between the
        // check and the write (G3); again below if the check takes the
        // file's other bytes as what this canvas saved.
        let base = savedText;
        let text = fileText(base, scene, formatOf(target));
        const verdict = await fileUnchanged(target);
        if (verdict === 'gone' && !removed && path === target && !closing) {
          // Moved or deleted elsewhere, not heard about yet: the change
          // waits for the rename (or is kept for a copy on the delete).
          restore(scene, seq);
          awaitingMove = true;
          return;
        }
        if (verdict !== 'same' && path === target) {
          // Changed (or, closing, gone) elsewhere: ask, as for a change heard about.
          if (!removed) {
            restore(scene, seq);
            startConflict(verdict === 'changed' ? theirsText : null);
          } else keepIfDeletedElsewhere(scene, seq);
          return;
        }
        if (removed || path !== target || seq <= droppedSeq) {
          if (seq <= droppedSeq) return;
          // Deleted or moved while this looked: decide again.
          if (!removed) {
            restore(scene, seq);
            void writeNow();
          } else keepIfDeletedElsewhere(scene, seq);
          return;
        }
        if (savedText !== base) {
          base = savedText;
          text = fileText(base, scene, formatOf(target));
        }
        inFlight = text;
        try {
          await store.write(target, text, base === null ? {} : { ifUnchanged: { text: base } });
        } catch (error: unknown) {
          if (errorName(error) === 'FileChangedError') {
            // Not what the check saw: it changed in between (or went).
            seen = null;
            if (removed || path !== target) continue;
            if ((error as FileChangedError).absent) {
              // Moved or deleted elsewhere, not heard about yet: the change
              // waits for the rename, and is kept for a copy on a delete.
              restore(scene, seq);
              awaitingMove = true;
              return;
            }
            // The check decides again: the same drawing in other bytes, or a conflict.
            if (attempt < 3) continue;
            restore(scene, seq);
            startConflict(await store.readText(target).catch(() => null));
            return;
          }
          // Keep the change, so the next save or flush tries again.
          restore(scene, seq);
          update({ error });
          return;
        } finally {
          if (inFlight === text) inFlight = null;
        }
        if (path !== target) {
          // Renamed while the write was in flight, so it landed where the
          // canvas was: write it again where the canvas is now. A rename in
          // another tab waits for this write and carries these bytes there:
          // they're this canvas's own, not a change made elsewhere (round 4,
          // F6). A store that doesn't carry them leaves what was saved before.
          // Only when nothing newer is pending or queued (G1).
          carriedText = text;
          if (!removed) {
            restore(scene, seq);
            void writeNow();
          } else keepIfDeletedElsewhere(scene, seq);
          return;
        }
        writtenSeq = Math.max(writtenSeq, seq);
        savedSignature = signature;
        savedText = text;
        carriedText = null;
        fileSignature = fileSignatureOf(scene);
        seen = await store.stat(target).catch(() => null);
        update({ error: undefined });
        return;
      }
    } finally {
      writes -= 1;
      settlePending();
    }
  };

  const writeNow = async () => {
    cancelTimer();
    // In a conflict nothing is written until Reload or Keep mine.
    if (state.conflict) return;
    // Deleted: nothing to write to (a change kept for its copy stays).
    if (removed) {
      settlePending();
      return;
    }
    const scene = pendingScene;
    const seq = pendingSeq;
    pendingScene = null;
    if (!scene) {
      settlePending();
      return;
    }
    // Taken: an older write that fails from now on doesn't put its scene back.
    takenSeq = Math.max(takenSeq, seq);
    const signature = signatureOf(scene);
    if (signature === savedSignature) {
      settlePending();
      return;
    }
    writes += 1;
    writing = writing.then(() => writeScene(scene, signature, seq));
    await writing;
  };

  /** Settles once the writes stop changing: a write aimed again after a
   * rename is queued after the one awaited (re-review R8). */
  const settled = async () => {
    for (let last = writing; ; last = writing) {
      await last;
      if (last === writing) return;
    }
  };

  const flush = async () => {
    await writeNow();
    await settled();
  };

  /** On dispose, in a conflict or deleted by another tab: writes the
   * pending drawing beside the file (or where it was), as a whole canvas,
   * and reports it. False when it couldn't. */
  const keepConflictCopy = async (): Promise<boolean> => {
    // The newest drawing the user made, whatever write held which (G2).
    const scene = pendingScene === null ? null : (latestScene ?? pendingScene);
    if (scene === null || (removed ? !deletedElsewhere : !state.conflict)) return true;
    let text: string | null = null;
    try {
      await writeAllowed(scope, () => path);
      const original = path;
      text = fileText(savedText, scene, formatOf(original));
      const copy = await writeConflictCopy(store, original, text);
      pendingScene = null;
      settlePending();
      reportKeptCopy(removed ? { scope, path: original, copy, deleted: true } : { scope, path: original, copy });
      return true;
    } catch (error: unknown) {
      // Not written: hand the change to the user as a download (round 4, F2).
      text ??= fileText(savedText, scene, formatOf(path));
      const download = { filename: conflictCopyName(path, [], new Date()), text };
      reportKeptCopy({ scope, path, copy: null, error, download, release: () => handle.close() });
      return false;
    }
  };

  return {
    load(ref: SceneStoreRef) {
      // Another session of this canvas may still be saving it (a tab closed
      // and opened again at once): read what that save writes.
      let stat: FileEntry | null = null;
      loading ??= writesSettled(scope, path, session)
        .then(async () => {
          // The stat first: a change landing between the two shows as one.
          stat = await store.stat(path).catch(() => null);
          return store.readText(path);
        })
        .then((text) => {
          const parsed = parseFile(text, formatOf(path));
          const read = parsed.scene;
          held = parsed.held;
          // A reload shows the new drawing where the canvas was looking.
          const scene = lastView ? { ...read, appState: { ...read.appState, ...lastView } } : read;
          savedText = text;
          seen = stat;
          fileSignature = fileSignatureOf(scene);
          loaded = true;
          update({ elementCount: liveElements(scene).length, zoom: zoomOf(scene) });
          return {
            type: NEBULA_EXCALIDRAW_DOCUMENT_TYPE,
            version: NEBULA_EXCALIDRAW_DOCUMENT_VERSION,
            boardId: ref.boardId,
            canvasId: ref.canvasId,
            name: nameOf(path),
            updatedAt: new Date().toISOString(),
            scene,
            nebula: createEmptyNebulaMetadata(),
          };
        });
      return loading;
    },

    async save(document: NebulaExcalidrawDocument) {
      if (!loaded || removed || closing) return;
      const scene = document.scene;
      latestScene = scene;
      latestSeq += 1;
      lastView = viewOf(scene) ?? lastView;
      const elementCount = liveElements(scene).length;
      const zoom = zoomOf(scene);
      const seen: Partial<FileSceneState> = {};
      if (elementCount !== state.elementCount) seen.elementCount = elementCount;
      if (zoom !== state.zoom) seen.zoom = zoom;
      const signature = signatureOf(scene);
      if (savedSignature === null) savedSignature = signature;
      if (signature === savedSignature && pendingScene === null) {
        if (Object.keys(seen).length > 0) update(seen);
        return;
      }
      pendingScene = scene;
      pendingSeq = latestSeq;
      update({ ...seen, pending: true });
      if (state.conflict) return;
      timer ??= setTimeout(() => {
        timer = null;
        void writeNow();
      }, intervalMs);
    },

    async list(): Promise<CanvasSummary[]> {
      return [{ canvasId: path, name: nameOf(path), updatedAt: new Date().toISOString() }];
    },

    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    flush,

    async reload() {
      cancelTimer();
      // Every save so far is dropped, a write still queued for one included:
      // only a write already in flight lands, and is read below.
      droppedSeq = latestSeq;
      takenSeq = Math.max(takenSeq, latestSeq);
      awaitingMove = false;
      await settled();
      pendingScene = null;
      latestScene = null;
      // What was carried, and the conflict's text, belong to before (G6).
      carriedText = null;
      theirsText = null;
      try {
        const text = await store.readText(path);
        takeFile(text, parseFile(text, formatOf(path)));
      } catch (error) {
        update({ error });
      }
      settlePending();
    },

    async keepMine() {
      // The newest drawing the user made (G2).
      const scene = latestScene ?? pendingScene;
      // Mine goes over the change the bar showed, and only that: a change
      // landing after it is asked about again (round 5). When the bar's
      // text isn't known, the file as it is now.
      try {
        const theirs = theirsText ?? (await store.readText(path));
        savedText = theirs;
        fileSignature = fileSignatureOf(parseScene(theirs, formatOf(path)));
      } catch {
        // The write below finds out.
      }
      seen = null;
      carriedText = null;
      theirsText = null;
      update({ conflict: false });
      if (!scene) return;
      pendingScene = scene;
      pendingSeq = latestSeq;
      // The file holds the other change: write this canvas whatever it was.
      savedSignature = null;
      await writeNow();
      await writing;
    },

    async dispose() {
      if (closing) return;
      closing = true;
      await flush();
      // A change held in a conflict isn't dropped: it goes beside the file
      // (re-review R1). Nothing of this canvas's pending (Reload, or no
      // change since), no copy.
      const kept = await keepConflictCopy();
      unwatch();
      listeners.clear();
      // A copy that couldn't be written stays unsaved, so the page still asks.
      if (kept) handle.close();
    },
  };
}
