import { errorName, type FileChangedError } from '../../../files/errors';
import { basename, isInside } from '../../../files/paths';
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
import { FolderUnreachableError, carryEdit, claimCarried, heldHere, openFileSession, reportKeptCopy, writeAllowed, writesSettled, type OpenFileSession, type SessionScope } from '../shared/fileSessions';
import { titleFromName } from '../shared/format';
import { withoutRemoteFiles, type SceneFiles } from './sceneFiles';

/**
 * A SceneStore over one canvas file:
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
  /** The folder the canvas is in can't be reached right now (S2): its name
   * ('' when unknown), or null. The change stays pending until it's back. */
  unreachable?: string | null;
  /** Another tab is moving the project to a folder (S3): writes wait. */
  moving?: boolean;
  /** Counts the times the scene was replaced from the file (a change made
   * elsewhere, or Reload): the canvas remounts to show it. */
  revision: number;
};

export type FileSceneStore = SceneStore & {
  /** A file's store: the shell shows a failed load as the error, not as an
   * empty canvas to draw on. */
  readonly fileBacked: true;
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
  /** How long a save that found its file gone waits for the rename before
   * it looks again, and, still gone, shows the file as deleted elsewhere
   * (H7). */
  goneCheckMs?: number;
};

export const CANVAS_SAVE_INTERVAL_MS = 400;
/** Another tab's rename reaches this one within milliseconds; a file still
 * gone after this long was deleted or moved out of reach (H7). */
export const GONE_CHECK_MS = 2000;

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
 * drawing keeps everything in its file that isn't the drawing: frontmatter, the notes above `# Excalidraw Data`, Element
 * Links, Embedded Files, and the drawing's encoding (the plugin's setting).
 * A new or empty file is written compressed, unless it holds more than
 * 256 KB of images: then it is written as plain JSON, which Obsidian's plugin
 * reads too. LZ can't shrink image data (it grew 15%) and took 2 s a save for
 * one 400 KB photo, 16 s for five and 52 s for twenty (measured 2026-10-25,
 * after Bruce asked about "too many images").
 *
 * `original` is the file's text as it is now: as opened, then as last
 * written, reloaded or taken from elsewhere; null when there's none. `format`
 * is 'json' for an `.excalidraw` file, which is Excalidraw's JSON.
 */
export function serialize(original: string | null, scene: ExcalidrawScene, format: CanvasFormat = 'markdown'): string {
  const clean = forFile(scene);
  if (format === 'markdown') return updateObsidianExcalidrawMarkdown(original ?? '', clean, imageBytes(clean) > COMPRESS_IMAGES_UP_TO ? { compressed: false } : {});
  const appState: Record<string, unknown> = {};
  for (const key of EXPORTED_APP_STATE) if (clean.appState && key in clean.appState) appState[key] = clean.appState[key];
  // Nebula draws on a transparent canvas so the sky shows; elsewhere that
  // would paint black, so files keep Excalidraw's white.
  if (!appState.viewBackgroundColor || appState.viewBackgroundColor === 'transparent') appState.viewBackgroundColor = '#ffffff';
  return JSON.stringify({ type: 'excalidraw', version: 2, source: clean.source, elements: clean.elements, appState, files: clean.files }, null, 2);
}

/** Above this much image data a drawing is written as plain JSON (serialize). */
const COMPRESS_IMAGES_UP_TO = 256 * 1024;

/** The characters of image data the scene's files carry. */
function imageBytes(scene: ExcalidrawScene): number {
  let total = 0;
  for (const file of Object.values(scene.files ?? {})) {
    const dataURL = (file as { dataURL?: unknown } | null)?.dataURL;
    if (typeof dataURL === 'string') total += dataURL.length;
  }
  return total;
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

/** The view settings a file keeps, as they're written:
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
 * and the view settings the file keeps. Cheap, and only for this canvas's
 * own saves (Excalidraw's echo, H6): never for another writer's bytes,
 * where two different drawings can carry the same versions (N1). */
function signatureOf(scene: ExcalidrawScene): string {
  const elements = scene.elements.map((element) => `${element.id}:${String(element.version ?? '')}:${element.isDeleted ? 1 : 0}`);
  return `${elements.join(',')}|${Object.keys(scene.files ?? {}).sort().join(',')}|${keptAppState(scene)}`;
}

/** The drawing a file holds, for telling a change made elsewhere from the
 * same drawing in other bytes: the live elements as the file has them, the
 * images they use, and the settings the file keeps. Never
 * versions: Excalidraw raises an element's version by one per change, so two
 * tabs changing one element from the same base reach the same version with
 * different drawings, and a hand edit of the JSON changes none. */
function fileSignatureOf(scene: ExcalidrawScene): string {
  const clean = forFile(scene);
  return JSON.stringify([clean.elements, Object.keys(clean.files ?? {}).sort(), keptAppState(clean)]);
}

/** The drawing a file's text holds (fileSignatureOf), null when it isn't a
 * drawing. Remembered for the last few texts, so a text is parsed for it
 * once: the text the canvas wrote or took is compared with each change
 * heard, and mostly only when one comes. */
function textSignatures() {
  const known = new Map<string, string | null>();
  const remember = (key: string, signature: string | null) => {
    known.delete(key);
    known.set(key, signature);
    if (known.size > 4) known.delete(known.keys().next().value!);
    return signature;
  };
  return {
    of(text: string, format: Format): string | null {
      const key = `${format}\n${text}`;
      if (known.has(key)) return remember(key, known.get(key)!);
      let signature: string | null;
      try {
        signature = fileSignatureOf(parseScene(text, format));
      } catch {
        signature = null;
      }
      return remember(key, signature);
    },
    /** A text already parsed: its drawing's signature, remembered. */
    parsed(text: string, format: Format, scene: ExcalidrawScene): string {
      const key = `${format}\n${text}`;
      return (known.has(key) ? remember(key, known.get(key)!) : remember(key, fileSignatureOf(scene)))!;
    },
  };
}

export function createFileSceneStore({
  store,
  path: initialPath,
  intervalMs = CANVAS_SAVE_INTERVAL_MS,
  scope = store,
  serialize: write = serialize,
  goneCheckMs = GONE_CHECK_MS,
}: FileSceneStoreOptions): FileSceneStore {
  let path = initialPath;
  let state: FileSceneState = { pending: false, elementCount: null, zoom: 1, conflict: false, removed: false, unreachable: null, revision: 0 };
  /** Where the canvas was last looking (scroll and zoom), from its saves. */
  let lastView: Record<string, unknown> | null = null;
  let loading: Promise<NebulaExcalidrawDocument> | null = null;
  /** Counts takeFile(): a load started before a newer one applies nothing
   * (H4). */
  let generation = 0;
  let loaded = false;
  /** The last load failed (the file moved, or wasn't a drawing, as it
   * read): the next load reads again, and the next change heard is taken. */
  let loadFailed = false;
  /** A change was heard while a load was under way: the file is checked
   * again once the load applies, or fails. */
  let heardWhileLoading = false;
  /** The next save is Excalidraw's echo of the scene a load gave it: its
   * signature becomes the baseline, and nothing is written for it. Set only
   * by a load (and takeFile), cleared by the first save after it (H1). */
  let echoPending = false;
  /** Keep mine's write goes out whatever the signatures say (H1). */
  let forceWrite = false;
  let removed = false;
  /** Removed by another tab (not by this one, nor with its project): this
   * canvas's own pending change is kept, and written beside where the file
   * was when the view goes. */
  let deletedElsewhere = false;
  /** The folder is out of reach (S2): nothing is written until it's back. */
  let paused = false;
  /** `removed` came from the gone check, which a folder out of reach also
   * trips: undone if `unreachable` follows. */
  let removedByGoneCheck = false;
  /** The project is moving to a folder (S3): nothing is written meanwhile. */
  let moving = false;
  /** It moved: a change still pending goes with it (carryEdit). */
  let movedAway = false;
  /** dispose() has begun: nothing new is taken, but renames and deletes are
   * followed until the last write is done. */
  let closing = false;
  /** The signature on disk (or the scene as it opened); null only before
   * the first load's echo. */
  let savedSignature: string | null = null;
  /** The signature of the newest write taken (queued or in flight): while
   * one is, a new scene is compared with it, not with the disk (H6). */
  let takenSignature: string | null = null;
  /** The file's text as this store last read or wrote it (what serialize()
   * gets as `original`), and the drawing it holds. */
  let savedText: string | null = null;
  /** The text whose drawing is this canvas's own: the file as last loaded,
   * taken or written by it (or, for Keep mine, the change it goes over).
   * Bytes holding that drawing (fileSignatureOf) are this canvas's own; it
   * is compared with a change only when one comes (N1). */
  let ownText: { text: string; format: Format } | null = null;
  const signatures = textSignatures();
  const ownSignature = () => (ownText ? signatures.of(ownText.text, ownText.format) : null);
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
  /** Saves are numbered: `latestSeq` is the newest the
   * canvas reported, `pendingSeq` the pending scene's, `takenSeq` the newest
   * a write has taken, `writtenSeq` the newest on disk. */
  let latestSeq = 0;
  let pendingSeq = 0;
  let takenSeq = 0;
  let writtenSeq = 0;
  /** Reload dropped every save up to this one: a write still queued for one
   * of them is never made. */
  let droppedSeq = 0;
  /** Reload is reading the file: nothing new is written until it has shown
   * it (or failed), so a change made meanwhile can't land over the file it's
   * taking. */
  let reloading = false;
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
  /** Looks again at a file a save found gone (H7). */
  let goneTimer: ReturnType<typeof setTimeout> | null = null;
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
    generation += 1;
    held = kept;
    savedText = text;
    seen = null;
    ownText = { text, format: formatOf(path) };
    signatures.parsed(text, formatOf(path), scene);
    // The remounted canvas's first save is the echo of this file.
    echoPending = true;
    forceWrite = false;
    loading = null;
    loadFailed = false;
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
   * drawing, and an older scene must never come back after it. */
  const restore = (scene: ExcalidrawScene, seq: number, force = false) => {
    // The newest write taken isn't landing: nothing in flight carries its
    // signature any more (H6).
    if (seq === takenSeq) takenSignature = null;
    if (pendingScene !== null || seq < takenSeq) return;
    pendingScene = scene;
    pendingSeq = seq;
    // Keep mine's write, given back, is still Keep mine's: the next try
    // writes it whatever the signatures say (round 7, canvas seed 14946).
    if (force) forceWrite = true;
  };

  /** A write to this file: an echo of this store's own save, the same
   * drawing in other bytes, or a change made elsewhere, taken at once when
   * nothing here is unsaved and otherwise held for Reload or Keep mine. */
  const checkFile = async () => {
    await writing;
    if (closing || removed) return;
    // Until a load applies, the canvas shows nothing of the file. After one
    // that failed, any drawing heard is taken, so the canvas remounts and
    // shows it (N3).
    if (!loaded && !loadFailed) {
      heardWhileLoading = true;
      return;
    }
    const recovering = !loaded;
    let text: string;
    let parsed: { scene: ExcalidrawScene; held: SceneFiles };
    try {
      text = await store.readText(path);
      if (!recovering && (text === savedText || text === inFlight || text === carriedText)) return;
      parsed = parseFile(text, formatOf(path));
    } catch {
      // Unreadable or not a drawing (yet): the next good write is checked.
      return;
    }
    if (closing || removed) return;
    if (recovering && (loaded || !loadFailed)) return;
    if (recovering) {
      if (pendingScene === null && writes === 0 && !state.conflict) takeFile(text, parsed);
      else startConflict(text);
      return;
    }
    const own = ownSignature();
    if (own !== null && signatures.parsed(text, formatOf(path), parsed.scene) === own) {
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

  /** Checks the file, after every check before it. */
  const check = () => {
    const run = () => checkFile();
    checking = checking.then(run, run);
  };

  const unwatch = store.watch((change: FileChange) => {
    if (change.type === 'unreachable') {
      // Not removed (S2): the change stays pending until the folder is back.
      paused = true;
      cancelTimer();
      if (removedByGoneCheck) {
        removedByGoneCheck = false;
        removed = false;
        deletedElsewhere = false;
        awaitingMove = true;
        update({ removed: false, unreachable: change.folder ?? '' });
      } else update({ unreachable: change.folder ?? '' });
      return;
    }
    if (change.type === 'reachable') {
      if (!paused) return;
      paused = false;
      awaitingMove = false;
      cancelGoneTimer();
      update({ unreachable: null });
      if (pendingScene !== null && !closing && !moving) void writeNow();
      return;
    }
    // Another tab moving the project to a folder (S3): writes wait; if it
    // fails they go on, and if it lands the view goes, and a change still
    // pending goes with it, to the session that opens the file there.
    if (change.type === 'moving') {
      moving = true;
      cancelTimer();
      update({ moving: true });
      return;
    }
    if (change.type === 'move-failed') {
      if (!moving) return;
      moving = false;
      update({ moving: false });
      if (pendingScene !== null && !closing && !paused) void writeNow();
      return;
    }
    if (change.type === 'moved') {
      // The workspace opens the project again from the folder; this view
      // goes, and nothing more is written from it.
      movedAway = true;
      moving = true;
      cancelTimer();
      return;
    }
    // The file itself, or a folder above it.
    if (change.type === 'rename' && isInside(path, change.from)) {
      path = change.to + path.slice(change.from.length);
      // A change heard just before it may have failed its read at the old
      // path: look at the file where it is now (N2). Only look: after an ABA
      // landing the change stays in the new file at the old path, and nothing
      // is written here on a guess (N5, R7-1).
      check();
      // A write that found the file gone was waiting for this.
      if (awaitingMove) {
        awaitingMove = false;
        cancelGoneTimer();
        void writeNow();
      }
    }
    if (change.type === 'write' && change.path === path) check();
    if (change.type === 'remove' && (change.path === '' || isInside(path, change.path))) {
      removed = true;
      removedByGoneCheck = false;
      // A delete made here holds this session's writes, and means to drop
      // the change; so does the project going.
      deletedElsewhere = change.path !== '' && !heldHere(scope, path);
      if (!deletedElsewhere) pendingScene = null;
      awaitingMove = false;
      cancelGoneTimer();
      cancelTimer();
      settlePending();
      update({ removed: true, conflict: false });
    }
  });

  /** Whether the file is still what this canvas last saw. Another tab's save
   * can land before its message does, and a write now would silently undo
   * it. Cheap when nothing changed: one stat. */
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
      const own = ownSignature();
      same = own !== null && signatures.of(text, formatOf(target)) === own;
    }
    if (same) {
      savedText = text;
      seen = now;
    } else theirsText = text;
    return same ? 'same' : 'changed';
  };

  const cancelGoneTimer = () => {
    if (goneTimer !== null) clearTimeout(goneTimer);
    goneTimer = null;
  };

  /** A write found the file gone, and no rename has been heard: the change
   * waits for one. If none comes and the file is still gone a little later,
   * it was deleted (or moved out of reach) elsewhere: say so, and keep the
   * change for a copy where it was. */
  const awaitMove = () => {
    awaitingMove = true;
    if (goneTimer !== null) return;
    goneTimer = setTimeout(() => {
      goneTimer = null;
      void (async () => {
        if (!awaitingMove || closing || removed || paused || moving) return;
        const target = path;
        const now = await store.stat(target).catch(() => undefined);
        if (now !== null || !awaitingMove || closing || removed || paused || path !== target) return;
        awaitingMove = false;
        removed = true;
        deletedElsewhere = true;
        removedByGoneCheck = true;
        cancelTimer();
        settlePending();
        update({ removed: true, conflict: false });
      })();
    }, goneCheckMs);
  };

  /** A write that found the file deleted by another tab keeps its scene. */
  const keepIfDeletedElsewhere = (scene: ExcalidrawScene, seq: number) => {
    if (deletedElsewhere) restore(scene, seq);
  };

  /** One write, decided when its turn comes: where the canvas is then, and
   * nothing at all once it's deleted or changed elsewhere. It writes only
   * over the text its check accepted: a save landing from another
   * tab after the check is refused under the write's own lock and asked
   * about, never overwritten. */
  const writeScene = async (scene: ExcalidrawScene, signature: string, seq: number, force = false): Promise<void> => {
    let landed = false;
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
        if (state.conflict || paused || moving) {
          restore(scene, seq, force);
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
          restore(scene, seq, force);
          awaitMove();
          return;
        }
        if (verdict !== 'same' && path === target) {
          // Changed (or, closing, gone) elsewhere: ask, as for a change heard about.
          if (!removed) {
            restore(scene, seq, force);
            startConflict(verdict === 'changed' ? theirsText : null);
          } else keepIfDeletedElsewhere(scene, seq);
          return;
        }
        if (removed || path !== target || seq <= droppedSeq) {
          if (seq <= droppedSeq) return;
          // Deleted or moved while this looked: decide again.
          if (!removed) {
            restore(scene, seq, force);
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
              // Closing, it can't wait: it's kept as a copy now.
              restore(scene, seq, force);
              if (closing) startConflict(null);
              else awaitMove();
              return;
            }
            // The check decides again: the same drawing in other bytes, or a conflict.
            if (attempt < 3) continue;
            restore(scene, seq, force);
            startConflict(await store.readText(target).catch(() => null));
            return;
          }
          // Keep the change, so the next save or flush tries again.
          restore(scene, seq, force);
          update({ error });
          return;
        } finally {
          if (inFlight === text) inFlight = null;
        }
        if (path !== target) {
          // Renamed while the write was in flight, so it landed where the
          // canvas was: write it again where the canvas is now. A rename in
          // another tab waits for this write and carries these bytes there:
          // they're this canvas's own, not a change made elsewhere. A store that doesn't carry them leaves what was saved before.
          // Only when nothing newer is pending or queued (G1).
          carriedText = text;
          if (!removed) {
            restore(scene, seq, force);
            void writeNow();
          } else keepIfDeletedElsewhere(scene, seq);
          return;
        }
        landed = true;
        writtenSeq = Math.max(writtenSeq, seq);
        savedSignature = signature;
        savedText = text;
        carriedText = null;
        // The drawing as written, read back as any other text is (N1).
        ownText = { text, format: formatOf(target) };
        seen = await store.stat(target).catch(() => null);
        update({ error: undefined });
        return;
      }
    } finally {
      if (!landed && seq === takenSeq) takenSignature = null;
      writes -= 1;
      settlePending();
    }
  };

  const writeNow = async () => {
    cancelTimer();
    // In a conflict nothing is written until Reload or Keep mine; nor while
    // Reload reads, nor while the folder is out of reach (S2).
    if (state.conflict || reloading || paused || moving) return;
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
    const signature = signatureOf(scene);
    const force = forceWrite;
    forceWrite = false;
    // Already on disk, or carried by the write in flight (H6). That write,
    // if it fails, still gives its scene back: nothing newer was taken.
    if (!force && signature === (writes > 0 ? takenSignature : savedSignature)) {
      settlePending();
      return;
    }
    // Taken: an older write that fails from now on doesn't put its scene back.
    takenSeq = Math.max(takenSeq, seq);
    takenSignature = signature;
    writes += 1;
    writing = writing.then(() => writeScene(scene, signature, seq, force));
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
      // Not written: hand the change to the user as a download.
      text ??= fileText(savedText, scene, formatOf(path));
      const download = { filename: conflictCopyName(path, [], new Date()), text };
      reportKeptCopy({ scope, path, copy: null, error, download, release: () => handle.close() });
      return false;
    }
  };

  /** On dispose, a change still pending after the flush, with no conflict
   * and no delete elsewhere: its write failed (a full store, an I/O error).
   * It's handed to the user as a download under the file's own name, and
   * the page keeps warning until they take it or let it go (H3). */
  const offerFailedSave = () => {
    const scene = latestScene ?? pendingScene!;
    const error = paused ? new FolderUnreachableError(state.unreachable ?? '') : (state.error ?? new Error('The change could not be saved.'));
    const download = { filename: basename(path), text: fileText(savedText, scene, formatOf(path)) };
    reportKeptCopy({ scope, path, copy: null, error, download, failedSave: true, release: () => handle.close() });
  };

  /** The change carried for this file across Move to a folder… (S3), parsed;
   * null when there is none (or when it can't be read as a drawing, in which
   * case it's offered as a download, never dropped). */
  const claimBrought = (): { parsed: { scene: ExcalidrawScene; held: SceneFiles }; base: string; done: () => void } | null => {
    const edit = claimCarried(scope, path);
    if (!edit) return null;
    try {
      return { parsed: parseFile(edit.text, formatOf(path)), base: edit.base, done: edit.done };
    } catch (error: unknown) {
      reportKeptCopy({ scope, path, copy: null, error, download: { filename: basename(path), text: edit.text }, failedSave: true, release: edit.done });
      return null;
    }
  };

  const load = (ref: SceneStoreRef): Promise<NebulaExcalidrawDocument> => {
    // Another session of this canvas may still be saving it (a tab closed
    // and opened again at once): read what that save writes.
    let stat: FileEntry | null = null;
    const startedAt = generation;
    if (loading) return loading;
    const attempt = (loading = writesSettled(scope, path, session)
      .then(async () => {
        // The stat first: a change landing between the two shows as one.
        stat = await store.stat(path).catch(() => null);
        return store.readText(path);
      })
      .then((text) => {
        // The file was taken again while this read (a change heard, Reload):
        // what this read is older, so it applies nothing; the canvas gets
        // the file as it is now (H4).
        if (startedAt !== generation) return load(ref);
        const parsed = parseFile(text, formatOf(path));
        // A change that came with the project from where it was (S3): shown
        // instead of the file, saved over the bytes it was made on, else
        // asked about.
        const brought = claimBrought();
        const read = brought ? brought.parsed.scene : parsed.scene;
        held = brought ? brought.parsed.held : parsed.held;
        // A reload shows the new drawing where the canvas was looking.
        const scene = lastView ? { ...read, appState: { ...read.appState, ...lastView } } : read;
        savedText = text;
        seen = stat;
        ownText = { text, format: formatOf(path) };
        signatures.parsed(text, formatOf(path), read);
        loaded = true;
        loadFailed = false;
        // A change heard while this read may have landed after it (N2).
        if (heardWhileLoading) {
          heardWhileLoading = false;
          check();
        }
        // Each load's echo sets the baseline anew (H4).
        echoPending = true;
        if (brought) {
          latestScene = read;
          latestSeq += 1;
          pendingScene = read;
          pendingSeq = latestSeq;
          update({ pending: true });
          if (text !== brought.base) startConflict(text);
          else timer ??= setTimeout(() => {
            timer = null;
            void writeNow();
          }, intervalMs);
          brought.done();
        }
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
      }));
    // A load that fails is tried again by the next one, and leaves the
    // canvas taking the next change heard (N3).
    attempt.then(
      () => undefined,
      () => {
        if (loading !== attempt) return;
        loading = null;
        if (!loaded) loadFailed = true;
        if (heardWhileLoading) {
          heardWhileLoading = false;
          check();
        }
      },
    );
    return attempt;
  };

  return {
    fileBacked: true,
    load,

    async save(document: NebulaExcalidrawDocument) {
      if (removed || closing) return;
      if (!loaded && !loadFailed) return;
      const scene = document.scene;
      if (!loaded) {
        // Drawn after a load that failed, on a canvas that never showed the
        // file (a host's fallback): never dropped silently, never written
        // over a file nobody saw. Held as a conflict, so the page warns and
        // Reload or Keep mine decides; closing keeps it as a copy (N3).
        // An empty canvas with nothing held (the fallback's own echo as it
        // mounts) is nothing to keep.
        if (pendingScene === null && liveElements(scene).length === 0) return;
        latestScene = scene;
        latestSeq += 1;
        pendingScene = scene;
        pendingSeq = latestSeq;
        update({ pending: true });
        if (!state.conflict) startConflict(null);
        return;
      }
      if (echoPending && pendingScene !== null) {
        // The echo of a load while a change is held: the change stays.
        echoPending = false;
        return;
      }
      latestScene = scene;
      latestSeq += 1;
      lastView = viewOf(scene) ?? lastView;
      const elementCount = liveElements(scene).length;
      const zoom = zoomOf(scene);
      const seen: Partial<FileSceneState> = {};
      if (elementCount !== state.elementCount) seen.elementCount = elementCount;
      if (zoom !== state.zoom) seen.zoom = zoom;
      const signature = signatureOf(scene);
      if (echoPending) {
        // Excalidraw's echo of the scene the load gave it.
        echoPending = false;
        if (pendingScene === null && writes === 0) savedSignature = signature;
      }
      // Compared with the newest write taken while one is queued or in
      // flight, not with the disk: a change back to the disk's state during
      // a write is a change too (H6).
      if (signature === (writes > 0 ? takenSignature : savedSignature) && pendingScene === null) {
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
      const before = { droppedSeq, awaitingMove, unsaved: state.pending, generation };
      droppedSeq = latestSeq;
      takenSeq = Math.max(takenSeq, latestSeq);
      awaitingMove = false;
      reloading = true;
      let text: string;
      let parsed: { scene: ExcalidrawScene; held: SceneFiles };
      try {
        await settled();
        text = await store.readText(path);
        parsed = parseFile(text, formatOf(path));
      } catch (error) {
        reloading = false;
        // Nothing was shown: the drawing, and the bar, stay as they were
        // (H2). A write Reload stopped gives the newest drawing back.
        droppedSeq = before.droppedSeq;
        if (before.awaitingMove && !removed) awaitMove();
        if (pendingScene === null && before.unsaved && generation === before.generation && latestScene !== null && latestSeq > writtenSeq && (!removed || deletedElsewhere)) {
          pendingScene = latestScene;
          pendingSeq = latestSeq;
        }
        update({ error });
        settlePending();
        // A change drawn while it read (or given back) is written as any
        // other: its own timer came while Reload held writes (N7).
        if (pendingScene !== null && !state.conflict && !removed) {
          timer ??= setTimeout(() => {
            timer = null;
            void writeNow();
          }, intervalMs);
        }
        return;
      }
      reloading = false;
      // Only now are the scenes dropped. What was carried, and the
      // conflict's text, belong to before (G6).
      pendingScene = null;
      latestScene = null;
      carriedText = null;
      theirsText = null;
      cancelGoneTimer();
      takeFile(text, parsed);
      update({ error: undefined });
      settlePending();
    },

    async keepMine() {
      if (state.conflict && theirsText === null) {
        // What the bar was raised for isn't known: read it, and ask again
        // with it, as the note does, rather than write over something
        // nobody has seen (H2). Unreadable, the bar stays as it is.
        const theirs = await store.readText(path).catch(() => null);
        if (theirs !== null && state.conflict && theirsText === null) theirsText = theirs;
        return;
      }
      // The newest drawing the user made (G2).
      const scene = latestScene ?? pendingScene;
      // Mine goes over the change the bar showed, and only that: a change
      // landing after it is asked about again.
      if (theirsText !== null) {
        savedText = theirsText;
        // Not a drawing, nothing of it can be the same as mine: its
        // signature is null, which matches nothing.
        ownText = { text: theirsText, format: formatOf(path) };
      }
      seen = null;
      carriedText = null;
      theirsText = null;
      update({ conflict: false });
      if (!scene) return;
      pendingScene = scene;
      pendingSeq = latestSeq;
      // The file holds the other change: write this canvas whatever its
      // signature says (H1: a flag, never a null that looks like a load).
      forceWrite = true;
      await writeNow();
      await writing;
    },

    async dispose() {
      if (closing) return;
      closing = true;
      cancelGoneTimer();
      await flush();
      // A change held in a conflict isn't dropped: it goes beside the file
      // (re-review R1). Nothing of this canvas's pending (Reload, or no
      // change since), no copy.
      const kept = await keepConflictCopy();
      unwatch();
      listeners.clear();
      // A copy that couldn't be written stays unsaved, so the page still asks.
      if (!kept) return;
      // The project moved to a folder with this change unsaved: it goes with
      // it, to the session that opens the file there (S3).
      if (movedAway && typeof scope === 'string' && savedText !== null && pendingScene !== null && !removed && !state.conflict) {
        carryEdit(scope, path, { text: fileText(savedText, latestScene ?? pendingScene, formatOf(path)), base: savedText });
        handle.close();
        return;
      }
      // Still pending with no conflict and no delete elsewhere: the write failed.
      if (pendingScene !== null && !removed && !state.conflict) {
        offerFailedSave();
        return;
      }
      handle.close();
    },
  };
}
