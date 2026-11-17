import { useCallback, useEffect, useMemo, useRef, useReducer, useState, useSyncExternalStore, type ChangeEvent, type ComponentType, type CSSProperties } from 'react';
import { kindFromName } from '../files/kinds';
import { PLANET_COLOURS } from '../files/palette';
import { onPersistenceAnswer, storageStatus } from '../files/persist';
import { FIRST_PROJECT_NAME, type FileKind, type FileStore, type FileViewProps, type FolderHandle, type Preferences, type ProjectRecord, type ProjectRegistry } from '../files/types';
import { NEBULA_LOGO_SRC } from '../nebula/ui/logo';
import { useMotion } from '../nebula/ui/useMotion';
import { useTheme } from '../nebula/ui/useTheme';
import { Button, Planet } from './components/Button';
import { ConfirmDialog, IntroDialog, NewProjectDialog, PromptDialog, type MigrationLeftBehind, type ProjectHome } from './components/Dialogs';
import { Help } from './components/Help';
import { iconForFile } from './components/fileIcon';
import { useEscapeLayer, useMediaQuery } from './components/hooks';
import { Icon } from './components/icons';
import { MenuEntries, ProjectContextMenu, ProjectMenu, WsContextMenu, type MenuEntry } from './components/Menus';
import { SEARCH_EVENT, type SearchRequest } from './searchEvent';
import { QuickOpen } from './components/QuickOpen';
import { Rail, type StarredItem } from './components/Rail';
import { SettingsDrawer, type SettingsTab } from './components/Settings';
import { useBackdrop } from './useBackdrop';
import { keptCopyText } from './keptCopyText';
import type { HeadingJump } from './components/headings';
import { OutlinePanel, Stage, StatusLine } from './components/Stage';
import { Tabs, type TabMeta } from './components/Tabs';
import { hasMod, menuAtElement, shortcutLabel, tabId, type MenuAt } from './components/ui';
import { downloadAsExcalidraw, downloadFile, downloadText } from './download';
import { countLabel, usageLabel } from './format';
import { downloadedLabel, lastDownloaded, recordDownload } from './downloads';
import { defaultFolders, type FolderActions } from './folders';
import { extractOutline, type Heading } from './outline';
import { basename, dirname, isInside, joinPath, uniqueName } from '../files/paths';
import { describeName, renameTarget, validateName } from './paths';
import { pastedNoteName } from './pasteNote';
import { addFiles } from './upload';
import { errorName, folderTooBigMessage } from '../files/errors';
import { usePreferences } from './preferences';
import { ProjectLinksContext, type LinePlace, type ProjectLinks } from './views/shared/projectLinks';
import { ProjectIndexProvider } from './ProjectIndexProvider';
import { useProjectIndexBuild } from './useProjectIndexBuild';
import { planNewNote } from './views/note/links';
import { PageWidthContext } from './views/shared/pageWidth';
import { describeConversions, isConvertible, replacedMoves, type ConvertOutcome, type ImageTools } from './imageConvert';
import { ConvertImagesDialog } from './components/ConvertImages';
import { buildTree } from './tree';
import { useProjectSession } from './useProjectSession';
import { viewFor as defaultViewFor } from './views';
import { hasUnsavedAt, hasUnsavedChanges, holdWrites, subscribeKeptCopies, subscribeUnsaved } from './views/shared/fileSessions';
import { linkRunMessage, updateLinksAfterMove, updateLinksAfterMoves } from './updateLinksRun';

export type WorkspaceProps = {
  /** `readOnly`, when the registry has it (the browser tier's), is true once
   * the project list turns out to be from a newer Nebula. */
  registry: ProjectRegistry & { readonly readOnly?: boolean };
  /** False when this browser won't keep files (private windows, storage
   * refused): the workspace says so, calmly, and offers a download. */
  persistent: boolean;
  /** Show the welcome (a first visit) or the one-time note for people whose
   * canvases moved into projects. */
  intro?: 'welcome' | 'migrated' | null;
  /** Called once the intro has been dismissed, so it isn't shown again. */
  onIntroDone?: () => void;
  /** For the 'migrated' note: canvases that stayed behind, and the move's
   * warnings (re-review R3). */
  leftBehind?: MigrationLeftBehind | null;
  /** Downloads a canvas that stayed behind (its localStorage key) as an
   * .excalidraw file. */
  onDownloadLeftBehind?: (key: string) => void;
  /** Canvases a Nebula 1.x tab saved after the move (re-review R6): looked
   * for once, when the workspace mounts, and offered quietly. The app gives
   * it in the browser tier only. */
  olderTabCanvases?: OlderTabOffer | null;
  /** Downloads a project as a .zip. Without it, Download as .zip is hidden. */
  downloadProject?: (id: string) => Promise<void>;
  /** The browser's image work for Convert image… (src/workspace/imageConvert.ts); tests swap in their own. */
  imageTools?: ImageTools;
  /** Help in the rail's footer. Without it, the workspace shows the app's
   * About dialog. */
  onHelp?: () => void;
  /** The view for each kind of file. Defaults to src/workspace/views; tests
   * and the harness swap in their own. */
  viewFor?: (kind: FileKind) => ComponentType<FileViewProps>;
  /** Open this project, and this file in it, on start: a /p/… link. Read
   * once, when the workspace mounts. */
  initialFile?: { projectId: string; path: string | null } | null;
  /** Called with the open project and file whenever either changes, so the
   * app can keep the address in step (null, null with no project). */
  onActiveFileChange?: (projectId: string | null, path: string | null) => void;
  /** The full address of a file or folder (path null: the project), for
   * Copy link, the link an Orbit card holds. Without it, no Copy link. */
  linkTo?: (projectId: string, path: string | null) => string;
  /** Something startup couldn't do, said at once above the files. */
  notice?: string | null;
  /** This device's own files, beside the projects (the browser tier's
   * `appearance/`): a background image. Without it, no images. */
  deviceStore?: FileStore;
  /** Folders on this computer: the browser's picker and its
   * permission prompts unless a test gives its own. */
  folders?: FolderActions;
};

/** A canvas a Nebula 1.x tab saved after the move: `projectId` is where its
 * earlier version went, null when it never moved. */
export type OlderTabCanvas = { key: string; name: string; updatedAt: string; projectId: string | null };

export type OlderTabOffer = {
  find(): Promise<OlderTabCanvas[]>;
  /** Writes it into the project as a new file; resolves with its path. */
  importCopy(key: string, projectId: string): Promise<string>;
  /** Downloads it as an .excalidraw file. */
  download(key: string): void;
  /** The user put these away: leave them out until saved again. */
  dismiss?(canvases: OlderTabCanvas[]): void;
};

/** A line about a change held in a conflict when its view went: where it
 * was kept, or (download) what to save because it couldn't be. */
type KeptLine = {
  key: number;
  text: string;
  /** The file's name as shown. */
  name: string;
  projectId: string | null;
  copy: string | null;
  download?: { filename: string; text: string };
  release?: () => void;
};

type DialogState =
  | {
      type: 'newProject';
      /** From the welcome's Start empty: the person's own first project. */
      first?: boolean;
    }
  | { type: 'confirm'; title: string; body: string; confirmLabel: string; danger?: boolean; onConfirm: () => void }
  /** Convert image… (one file) or Convert images… (a folder's, with its path). */
  | { type: 'convert'; paths: string[]; folder: string | null }
  | {
      type: 'prompt';
      title: string;
      label: string;
      initialValue: string;
      confirmLabel: string;
      onSubmit: (value: string) => void;
    }
  | null;

type FileMenuState = { path: string | null; at: MenuAt } | null;

const NEW_NOTE = 'Untitled.md';
const NEW_CANVAS = 'Untitled.excalidraw.md';
const NEW_FOLDER = 'New folder';

function byCreated(a: ProjectRecord, b: ProjectRecord): number {
  return a.created.localeCompare(b.created) || a.name.localeCompare(b.name);
}

function nextColour(projects: ProjectRecord[]): string {
  const used = new Set(projects.map((project) => project.color.toLowerCase()));
  return (PLANET_COLOURS.find((colour) => !used.has(colour.value)) ?? PLANET_COLOURS[projects.length % PLANET_COLOURS.length]).value;
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** The Nebula workspace: projects, their files, and the open file. */
export function Workspace({
  registry,
  persistent,
  intro = null,
  onIntroDone,
  leftBehind = null,
  onDownloadLeftBehind,
  olderTabCanvases = null,
  downloadProject,
  imageTools,
  onHelp,
  viewFor = defaultViewFor,
  initialFile = null,
  onActiveFileChange,
  linkTo,
  notice = null,
  deviceStore,
  folders = defaultFolders(),
}: WorkspaceProps) {
  const theme = useTheme();
  const backdrop = useBackdrop(theme.resolved, deviceStore);
  const motion = useMotion();
  const { preferences, setPreference } = usePreferences();
  // The note's page width switch: the same preference as Settings → Page width.
  const pageWidth = useMemo(
    () => ({ width: preferences.width, setWidth: (width: Preferences['width']) => setPreference('width', width) }),
    [preferences.width, setPreference],
  );
  const phone = useMediaQuery('(max-width: 768px)');
  const night = theme.resolved === 'dark';

  /* ---- projects ---------------------------------------------------- */

  const [projectList, setProjectList] = useState<ProjectRecord[] | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const projects = useMemo(() => (projectList ? [...projectList].sort(byCreated) : []), [projectList]);
  const project = projects.find((record) => record.id === currentId) ?? null;
  const many = projects.length > 1;
  const dockShown = preferences.dock && many;

  // A link opens its project, then its file, once (see the effect below).
  const link = useRef(initialFile);
  const [linkPending, setLinkPending] = useState(initialFile !== null);

  // A project list from a newer Nebula can be opened, not changed
  // (re-review R5). The registry knows once it has read the list.
  const [listLocked, setListLocked] = useState(false);

  const reloadProjects = useCallback(async () => {
    const list = await registry.list();
    setProjectList(list);
    setListLocked(registry.readOnly === true);
    return list;
  }, [registry]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [list, current] = await Promise.all([registry.list(), registry.current()]);
      if (cancelled) return;
      setProjectList(list);
      setListLocked(registry.readOnly === true);
      const has = (id: string | null | undefined): id is string => Boolean(id) && list.some((record) => record.id === id);
      const linked = link.current?.projectId;
      setCurrentId(has(linked) ? linked : has(current) ? current : (list[0]?.id ?? null));
    })().catch((reason: unknown) => console.error('Nebula could not list projects', reason));
    return () => {
      cancelled = true;
    };
  }, [registry]);

  // A folder project whose folder Nebula can't open now (the browser forgot
  // the permission, the person said no, or the folder is gone) isn't opened:
  // a bar over it says why, and how to open it again.
  // A folder on this computer, where the browser can open one and keeps the
  // project list (Chromium on a desktop; not a private window).
  const canUseFolders = persistent && folders.supported;
  // An open folder project whose folder went out of reach stays open (S2):
  // its tabs and sessions keep what's unsaved, and the bar says why.
  const [heldOpen, setHeldOpen] = useState<string | null>(null);
  const unreachableFolder = heldOpen !== null && heldOpen === currentId && project?.tier === 'folder' && project.folder ? project.folder : null;
  const blocked = project?.tier === 'folder' && project.folder && project.folder.access !== 'granted' && !unreachableFolder ? project.folder : null;
  // Bumped when a held-open project's folder is chosen again: it opens anew
  // from the folder picked.
  const [reopened, setReopened] = useState(0);
  const session = useProjectSession(registry, blocked ? null : currentId, `${project?.tier ?? ''}#${reopened}`);
  const { store, entries, ws, dispatch, kinds, refresh, gone, removing } = session;
  const sessionReady = session.ready && session.projectId === currentId;
  const sessionUnreachable = session.projectId === currentId ? session.unreachable : null;
  // Move to a folder… running, in this tab or another (S3): no New, no
  // Upload, until it's done.
  const [movingHere, setMovingHere] = useState(false);
  const isMoving = movingHere || (session.projectId === currentId && session.moving);
  const movingRef = useRef(false);
  movingRef.current = isMoving;
  // Converting images writes into the project, so it waits while the project
  // moves or its folder is out of reach (2.1.0, where conversion met the folder tier).
  const convertWait = isMoving
    ? 'The project is moving to a folder. Convert images once it’s moved.'
    : unreachableFolder
      ? `Nebula can’t reach the folder ‘${unreachableFolder.name}’ right now. Convert images once it’s back.`
      : null;
  // The bar over a folder project: one that can't be opened, or one held
  // open while its folder is out of reach (said as missing until the
  // registry says more).
  const folderBar = blocked ?? (unreachableFolder ? { ...unreachableFolder, access: unreachableFolder.access === 'granted' ? ('missing' as const) : unreachableFolder.access } : null);

  // A folder project that wouldn't open, or whose folder went while open:
  // ask the registry again, so the bar says what's wrong.
  const sessionError = session.error;
  const projectTier = project?.tier;
  useEffect(() => {
    if (sessionError && projectTier === 'folder') void reloadProjects().catch(() => {});
  }, [sessionError, projectTier, reloadProjects]);

  // Another tab moved the project to a folder: the registry says so now,
  // and the project opens again from there (same id).
  const sessionMoved = session.moved;
  useEffect(() => {
    if (sessionMoved > 0) void reloadProjects().catch(() => {});
  }, [sessionMoved, reloadProjects]);

  // Out of reach: held open, and the registry asked why ('prompt', 'denied'
  // or 'missing'). Back: asked again first, so the project isn't shut on
  // the old answer, and then let go.
  const sessionProject = session.projectId;
  useEffect(() => {
    if (sessionUnreachable !== null && sessionProject) {
      setHeldOpen(sessionProject);
      void reloadProjects().catch(() => {});
      return;
    }
    if (sessionUnreachable === null && heldOpen !== null) {
      let cancelled = false;
      void reloadProjects()
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setHeldOpen(null);
        });
      return () => {
        cancelled = true;
      };
    }
    return undefined;
  }, [sessionUnreachable, sessionProject, heldOpen, reloadProjects]);

  /* ---- what's on screen --------------------------------------------- */

  const [collapsed, setCollapsed] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // A tag clicked anywhere (a note, the editor, the Tags panel) opens search with `#tag` (searchEvent.ts).
  const [paletteQuery, setPaletteQuery] = useState<{ query: string; n: number } | undefined>(undefined);
  useEffect(() => {
    const onSearch = (event: Event) => {
      const { query } = (event as CustomEvent<SearchRequest>).detail;
      event.preventDefault();
      setPaletteQuery((last) => ({ query, n: (last?.n ?? 0) + 1 }));
      setPaletteOpen(true);
    };
    window.addEventListener(SEARCH_EVENT, onSearch);
    return () => window.removeEventListener(SEARCH_EVENT, onSearch);
  }, []);
  // Ctrl/⌘-K after a tag search starts empty again.
  useEffect(() => {
    if (!paletteOpen) setPaletteQuery((last) => (last && last.query ? { query: '', n: last.n } : last));
  }, [paletteOpen]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [projectMenu, setProjectMenu] = useState<{ id: string; at: MenuAt; fromSwitcher: boolean } | null>(null);
  const [fileMenu, setFileMenu] = useState<FileMenuState>(null);
  const [tabMenu, setTabMenu] = useState<{ path: string; at: MenuAt } | null>(null);
  const [newMenu, setNewMenu] = useState<MenuAt | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  // Settings opens where it was last left in this visit: Appearance, its first tab, at first.
  const [lastSettingsTab, setLastSettingsTab] = useState<SettingsTab>('appearance');
  const showSettingsTab = useCallback((tab: SettingsTab) => {
    setSettingsTab(tab);
    setLastSettingsTab(tab);
  }, []);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [introDone, setIntroDone] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ path: string; n: number } | null>(null);
  const [meta, setMeta] = useState<Record<string, TabMeta>>({});
  /** Files shown in another kind's view than their own, until their tab
   * closes: a canvas that won't open, as a note. */
  const [kindOverrides, setKindOverrides] = useState<Record<string, FileKind>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [outline, setOutline] = useState<Heading[] | null>(null);
  /** Whether the browser has agreed to keep the files (null: it doesn't
   * say), read when Settings opens; undefined until then. */
  const [kept, setKept] = useState<boolean | null | undefined>(undefined);

  const switcherRef = useRef<HTMLButtonElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadFolder = useRef('');
  const messageTimer = useRef<number | undefined>(undefined);

  const notify = useCallback((text: string) => {
    window.clearTimeout(messageTimer.current);
    setMessage(text);
    messageTimer.current = window.setTimeout(() => setMessage(null), 5000);
  }, []);
  useEffect(() => () => window.clearTimeout(messageTimer.current), []);

  const fail = useCallback(
    (what: string) => (reason: unknown) => {
      console.error(`Nebula: ${what}`, reason);
      notify(`${what}: ${errorText(reason)}`);
    },
    [notify],
  );

  const requestFocus = useCallback((path: string) => {
    setFocusRequest((current) => ({ path, n: (current?.n ?? 0) + 1 }));
  }, []);

  /** Shows a file or folder in the file tree: the folders above it open, the
   * rail (on a phone, the files sheet) open, and its row focused. A folder
   * link opens the folder itself too, so its files are in view. */
  const showInFiles = useCallback(
    (path: string, openFolder = false) => {
      dispatch({ type: 'reveal', path });
      if (openFolder) dispatch({ type: 'setExpanded', path, expanded: true });
      if (phone) setSheet(true);
      else setCollapsed(false);
      requestFocus(path);
    },
    [dispatch, phone, requestFocus],
  );

  /** Copy link: the address of a file or folder, for an Orbit card or a note.
   * It opens wherever the project lives, so the message says so. */
  const copyLink = useCallback(
    (path: string | null) => {
      if (!linkTo || !currentId) return;
      const url = linkTo(currentId, path);
      const copied = () => notify('Link copied. It opens in this browser, where the project is.');
      const show = () => window.prompt('Copy this link', url);
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(copied, show);
      else show();
    },
    [linkTo, currentId, notify],
  );

  // A new project starts with nothing open and nothing in flight.
  const [shownProject, setShownProject] = useState(currentId);
  if (shownProject !== currentId) {
    setShownProject(currentId);
    setMeta({});
    setKindOverrides({});
    setRenaming(null);
    setFileMenu(null);
    setTabMenu(null);
    setOutline(null);
  }

  // The file on screen stays readable by path after it's deleted elsewhere (gone).
  const entryByPath = useMemo(() => new Map((gone ? [...entries, gone] : entries).map((entry) => [entry.path, entry])), [entries, gone]);
  const tree = useMemo(() => buildTree(entries), [entries]);
  const expanded = useMemo(() => new Set(ws.expanded), [ws.expanded]);
  const files = useMemo(() => entries.filter((entry) => entry.type === 'file'), [entries]);
  // The project index: every note's and canvas's words and links, for search and Linked from.
  const projectIndex = useProjectIndexBuild(store, files);
  const usage = usageLabel(entries);
  // Where the files live, as the switcher, the menu and quick open say it.
  const browserLocation = persistent ? 'In this browser' : 'In this tab only';
  const locationOf = useCallback(
    (record: ProjectRecord) => (record.tier === 'folder' ? 'On this computer' : record.tier === 'server' ? `On ${record.server?.label ?? 'the server'}` : browserLocation),
    [browserLocation],
  );
  const location = project ? locationOf(project) : browserLocation;
  // A folder project's folder: the status names it, and the browser can't clear it.
  const folderName = project?.tier === 'folder' ? (project.folder?.name ?? project.name) : null;
  // A server project: what the server calls itself, and the project's folder there.
  const serverPlace = useMemo(
    () => (project?.tier === 'server' ? (project.server ?? { label: 'the server', folder: project.name }) : null),
    [project],
  );
  // How a file's delete says where it goes from.
  const deletedFrom = serverPlace
    ? `the folder ‘${serverPlace.folder}’ on ${serverPlace.label}`
    : folderName
      ? `the folder ‘${folderName}’ on this computer`
      : persistent
        ? 'this browser'
        : 'this tab';
  const activeEntry = ws.active ? (entryByPath.get(ws.active) ?? null) : null;
  const activeKind: FileKind | null = activeEntry ? (kindOverrides[activeEntry.path] ?? kinds[activeEntry.path] ?? null) : null;
  const iconKind = (path: string) => kinds[path] ?? kindFromName(basename(path));

  const starred: StarredItem[] = ws.starred.flatMap((path) => {
    const entry = entryByPath.get(path);
    if (!entry) return [];
    const label = entry.type === 'dir' ? entry.name : describeName(entry.name).label;
    return [{ path, label, icon: entry.type === 'dir' ? ('folder' as const) : iconForFile(entry.name, iconKind(path)) }];
  });

  /* ---- opening files ------------------------------------------------ */

  const openFile = useCallback(
    (path: string) => {
      dispatch({ type: 'open', path });
      dispatch({ type: 'reveal', path });
      setSheet(false);
    },
    [dispatch],
  );

  /** A link to a heading: the file opens, and the stage scrolls to the heading once the view has drawn it. */
  const [jump, setJump] = useState<HeadingJump | null>(null);
  const jumps = useRef(0);
  const openLinked = useCallback(
    (path: string, heading?: string, place?: LinePlace) => {
      openFile(path);
      if (heading || place) {
        jumps.current += 1;
        setJump({ path, heading: heading ?? '', place, n: jumps.current });
      }
    },
    [openFile],
  );

  const closeTab = useCallback(
    (path: string) => {
      dispatch({ type: 'close', path });
      setMeta((current) => {
        if (!(path in current)) return current;
        const next = { ...current };
        delete next[path];
        return next;
      });
      setKindOverrides((current) => {
        if (!(path in current)) return current;
        const next = { ...current };
        delete next[path];
        return next;
      });
    },
    [dispatch],
  );

  const openAs = useCallback((path: string, kind: FileKind) => {
    setKindOverrides((current) => ({ ...current, [path]: kind }));
  }, []);

  // A choice lasts as long as the file's tab: one deleted (or renamed in
  // another tab) lets it go, so a new file there opens as what it is.
  useEffect(() => {
    setKindOverrides((current) => {
      const kept = Object.entries(current).filter(([path]) => ws.tabs.includes(path));
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
    });
  }, [ws.tabs]);

  const onStatus = useCallback((path: string, text: string) => {
    setMeta((current) => (current[path]?.status === text ? current : { ...current, [path]: { ...current[path], status: text } }));
  }, []);

  const onDirty = useCallback((path: string, dirty: boolean) => {
    setMeta((current) => (current[path]?.dirty === dirty ? current : { ...current, [path]: { ...current[path], dirty } }));
  }, []);

  // Closing the page while something isn't saved asks first: an open view with unsaved edits, or a session still writing after
  // its tab was left.
  const sessionsUnsaved = useSyncExternalStore(subscribeUnsaved, hasUnsavedChanges);
  const unsaved = sessionsUnsaved || Object.values(meta).some((value) => value.dirty === true);
  useEffect(() => {
    if (!unsaved) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers ask only when returnValue is set.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [unsaved]);

  // A change held in a conflict when its view went is kept beside the file
  // (re-review R1): say so, once, and offer the copy.
  // A copy that couldn't be written is offered as a download instead; the page asks before closing until it's downloaded or dismissed.
  const [keptCopies, setKeptCopies] = useState<KeptLine[]>([]);
  useEffect(() => {
    let key = 0;
    return subscribeKeptCopies((kept) => {
      const name = describeName(basename(kept.path)).label;
      const text = keptCopyText(kept);
      key += 1;
      const line: KeptLine = { key, text, name, projectId: typeof kept.scope === 'string' ? kept.scope : null, copy: kept.copy };
      if (kept.copy === null) {
        line.download = kept.download;
        line.release = kept.release;
      }
      setKeptCopies((current) => [...current, line]);
      notify(text);
    });
  }, [notify]);
  // Dismissing a change that couldn't be kept lets it go: the user has chosen.
  const dismissKept = useCallback((item: KeptLine) => {
    item.release?.();
    setKeptCopies((current) => current.filter((other) => other.key !== item.key));
  }, []);
  const downloadKept = useCallback(
    (item: KeptLine) => {
      if (!item.download) return;
      try {
        downloadText(item.download.text, item.download.filename);
      } catch (reason: unknown) {
        fail('Couldn’t download your changes')(reason);
        return;
      }
      dismissKept(item);
    },
    [dismissKept, fail],
  );

  // Canvases an older tab saved after the move: offered once per visit,
  // quietly, until imported, downloaded or put away (re-review R6).
  const [olderTab, setOlderTab] = useState<OlderTabCanvas[]>([]);
  const askedOlderTab = useRef(false);
  useEffect(() => {
    if (!olderTabCanvases || askedOlderTab.current) return;
    askedOlderTab.current = true;
    olderTabCanvases.find().then(setOlderTab, (reason: unknown) => console.error('Nebula could not look for older tabs’ canvases', reason));
  }, [olderTabCanvases]);

  const moveMeta = useCallback((from: string, to: string) => {
    const move = <T,>(current: Record<string, T>) => {
      const next: Record<string, T> = {};
      for (const [path, value] of Object.entries(current)) {
        next[isInside(path, from) ? to + path.slice(from.length) : path] = value;
      }
      return next;
    };
    setMeta(move);
    setKindOverrides(move);
  }, []);

  /* ---- links and the address ---------------------------------------- */

  // The linked project opened first (above); its file opens once the
  // project's files are listed. A link to something that isn't here says so.
  useEffect(() => {
    const wanted = link.current;
    if (!wanted || projectList === null) return;
    const settle = () => {
      link.current = null;
      setLinkPending(false);
    };
    if (!projectList.some((record) => record.id === wanted.projectId)) {
      settle();
      notify('That link’s project isn’t in this browser.');
      return;
    }
    if (currentId !== wanted.projectId) {
      // Switched elsewhere before the project opened: the link is spent.
      if (currentId !== null) settle();
      return;
    }
    if (!sessionReady) return;
    settle();
    if (!wanted.path) return;
    const entry = entryByPath.get(wanted.path);
    if (entry?.type === 'file') openFile(wanted.path);
    // A folder link (from an Orbit card, say): the folder, open in the tree.
    else if (entry?.type === 'dir') showInFiles(wanted.path, true);
    else notify(`“${basename(wanted.path)}” isn’t in ${project?.name ?? 'this project'}.`);
  }, [projectList, currentId, sessionReady, entryByPath, project, openFile, showInFiles, notify]);

  // The open project and file, for the address. Quiet until a link has
  // opened, so the file restored underneath it never flashes by.
  const activePath = sessionReady ? ws.active : null;
  useEffect(() => {
    if (!onActiveFileChange || linkPending || projectList === null) return;
    if (currentId !== null && !sessionReady) return;
    onActiveFileChange(currentId, activePath);
  }, [onActiveFileChange, linkPending, projectList, currentId, sessionReady, activePath]);

  /* ---- file operations ---------------------------------------------- */

  const siblingNames = useCallback(
    async (folder: string, except?: string) => {
      if (!store) return [];
      const list = await store.list();
      return list.filter((entry) => dirname(entry.path) === folder && entry.path !== except).map((entry) => entry.name);
    },
    [store],
  );

  const createFile = useCallback(
    async (folder: string, desired: string) => {
      if (!store || movingRef.current) return;
      const name = uniqueName(await siblingNames(folder), desired);
      const path = joinPath(folder, name);
      await store.write(path, '');
      await refresh();
      if (folder) dispatch({ type: 'setExpanded', path: folder, expanded: true });
      openFile(path);
      // Name it straight away, where the rail is on screen.
      if (!phone && !collapsed) setRenaming(path);
    },
    [store, siblingNames, refresh, dispatch, openFile, phone, collapsed],
  );

  const createFolder = useCallback(
    async (parent: string) => {
      if (!store || movingRef.current) return;
      const name = uniqueName(await siblingNames(parent), NEW_FOLDER);
      const path = joinPath(parent, name);
      await store.mkdir(path);
      await refresh();
      dispatch({ type: 'reveal', path });
      if (parent) dispatch({ type: 'setExpanded', path: parent, expanded: true });
      setRenaming(path);
    },
    [store, siblingNames, refresh, dispatch],
  );

  const newNote = useCallback((folder = '') => void createFile(folder, NEW_NOTE).catch(fail('Couldn’t make a note')), [createFile, fail]);
  const newCanvas = useCallback(
    (folder = '') => void createFile(folder, NEW_CANVAS).catch(fail('Couldn’t make a canvas')),
    [createFile, fail],
  );
  const newFolder = useCallback((parent = '') => void createFolder(parent).catch(fail('Couldn’t make a folder')), [createFolder, fail]);

  /** Paste as note: the clipboard's text as a new note in `folder`, named by
   * when it was pasted (src/workspace/pasteNote.ts). Opened, not renamed:
   * the time is the point of the name. */
  const pasteNote = useCallback(
    async (folder: string) => {
      if (!store || movingRef.current) return;
      let text: string;
      try {
        text = (await navigator.clipboard?.readText?.()) ?? '';
      } catch {
        notify('Nebula couldn’t read the clipboard here. Make a note and paste into it instead.');
        return;
      }
      if (!text.trim()) {
        notify('There’s no text on the clipboard to paste.');
        return;
      }
      const path = joinPath(folder, uniqueName(await siblingNames(folder), pastedNoteName(text, new Date())));
      await store.write(path, text);
      await refresh();
      if (folder) dispatch({ type: 'setExpanded', path: folder, expanded: true });
      openFile(path);
    },
    [store, notify, siblingNames, refresh, dispatch, openFile],
  );
  const pasteAsNote = useCallback((folder = '') => void pasteNote(folder).catch(fail('Couldn’t make a note')), [pasteNote, fail]);

  /** A click on a link to a note that isn't there: an empty note by that name
   * in the folder of the note holding the link, opened. Never over a file
   * that's there (the write is exclusive: one made meanwhile just opens),
   * and a name Nebula refuses says why. */
  const createLinked = useCallback(
    (target: string, from: string) => {
      if (!store || movingRef.current) return;
      const plan = planNewNote(target, from);
      if ('problem' in plan) {
        notify(plan.problem);
        return;
      }
      void (async () => {
        try {
          await store.write(plan.path, '', { exclusive: true });
        } catch (reason) {
          if (errorName(reason) !== 'FileExistsError') throw reason;
        }
        await refresh();
        openFile(plan.path);
      })().catch(fail('Couldn’t make the note'));
    },
    [store, notify, refresh, openFile, fail],
  );

  /** What a note's links need of the project: its files, a way to open one (at a heading, if the link names it), and a way to make the note a link names. */
  const projectLinks = useMemo<ProjectLinks>(() => ({ files, open: openLinked, create: createLinked }), [files, openLinked, createLinked]);

  /** store.rename, once what the open files under `from` have pending is
   * written there; their next writes wait until it's done, then follow it. */
  const moveWithSessions = useCallback(
    async (from: string, to: string) => {
      if (!store || !currentId) return;
      const release = await holdWrites(currentId, from);
      try {
        await store.rename(from, to);
      } finally {
        release();
      }
    },
    [store, currentId],
  );

  /** After a rename or a move: the notes that link to what moved follow it
   * (updateLinks.ts), each written the way a tab's save writes, and the
   * status line says what was done. It runs after the rename, which never
   * waits for it and never fails because of it: whatever goes wrong is only
   * logged, and a note it can't update says so. */
  const followLinks = useCallback(
    (from: string, to: string) => {
      if (!store || !currentId) return;
      const scope = currentId;
      updateLinksAfterMove(store, { from, to, unsaved: (path) => hasUnsavedAt(scope, path) }).then(
        (run) => {
          const said = linkRunMessage(run);
          if (said) notify(said);
        },
        (reason: unknown) => console.error('Nebula: links weren’t updated after the move', reason),
      );
    },
    [store, currentId, notify],
  );

  const renameEntry = useCallback(
    async (path: string, typed: string): Promise<string | null> => {
      const entry = entryByPath.get(path);
      if (!store || !entry) return 'It’s no longer here.';
      const problem = validateName(typed);
      if (problem) return problem;
      const name = renameTarget(entry.name, typed, entry.type === 'dir');
      if (name === entry.name) {
        setRenaming(null);
        return null;
      }
      const folder = dirname(path);
      const taken = await siblingNames(folder, path);
      if (taken.some((other) => other.toLowerCase() === name.toLowerCase())) return `There’s already something called “${name}” here.`;
      const to = joinPath(folder, name);
      try {
        await moveWithSessions(path, to);
      } catch (reason) {
        return `Couldn’t rename it: ${errorText(reason)}`;
      }
      dispatch({ type: 'renamed', from: path, to });
      moveMeta(path, to);
      setRenaming(null);
      followLinks(path, to);
      await refresh();
      requestFocus(to);
      return null;
    },
    [entryByPath, store, siblingNames, moveWithSessions, followLinks, dispatch, moveMeta, refresh, requestFocus],
  );

  const moveEntry = useCallback(
    async (from: string, folder: string) => {
      if (!store) return;
      const name = basename(from);
      const to = joinPath(folder, name);
      if (to === from || isInside(folder, from)) return;
      const taken = await siblingNames(folder);
      if (taken.some((other) => other.toLowerCase() === name.toLowerCase())) {
        notify(`${folder ? `“${basename(folder)}”` : 'The top level'} already has something called “${name}”.`);
        return;
      }
      await moveWithSessions(from, to);
      dispatch({ type: 'renamed', from, to });
      moveMeta(from, to);
      followLinks(from, to);
      if (folder) dispatch({ type: 'setExpanded', path: folder, expanded: true });
      await refresh();
      requestFocus(to);
    },
    [store, siblingNames, notify, moveWithSessions, followLinks, dispatch, moveMeta, refresh, requestFocus],
  );

  const uploadFiles = useCallback(
    async (list: File[], folder: string) => {
      if (!store || list.length === 0) return;
      if (movingRef.current) {
        notify('The project is moving to a folder. Add the files once it’s moved.');
        return;
      }
      // Each file under a safe, free name; one that can't go in is skipped
      // with a word, and the rest still go in.
      const { added, skipped } = await addFiles(store, folder, list, await siblingNames(folder));
      if (folder && added.length > 0) dispatch({ type: 'setExpanded', path: folder, expanded: true });
      await refresh();
      const said: string[] = [];
      if (added.length > 0) said.push(`Added ${countLabel(added.length, 'file')}${folder ? ` to ${basename(folder)}` : ''}.`);
      if (skipped.length > 0) said.push(`Couldn’t add ${skipped.join(' ')}`);
      notify(said.join(' '));
      if (added[0]) requestFocus(added[0]);
    },
    [store, siblingNames, dispatch, refresh, notify, requestFocus],
  );

  const pickUpload = useCallback((folder = '') => {
    uploadFolder.current = folder;
    uploadInput.current?.click();
  }, []);

  const onUploadChange = (event: ChangeEvent<HTMLInputElement>) => {
    const list = [...(event.target.files ?? [])];
    event.target.value = '';
    void uploadFiles(list, uploadFolder.current).catch(fail('Couldn’t add the files'));
  };

  const confirmDelete = useCallback(
    (path: string) => {
      const entry = entryByPath.get(path);
      if (!store || !entry) return;
      const shown = entry.type === 'dir' ? entry.name : describeName(entry.name).label;
      const inside = entry.type === 'dir' ? entries.filter((other) => other.type === 'file' && isInside(other.path, path)).length : 0;
      // A folder's files go for good: the system's bin never sees them.
      const undone = serverPlace
        ? 'It won’t go to a bin, so this can’t be undone here.'
        : folderName
          ? 'It won’t go to your computer’s bin, so this can’t be undone.'
          : 'This can’t be undone.';
      setDialog({
        type: 'confirm',
        title: `Delete “${shown}”?`,
        body:
          entry.type === 'dir'
            ? `The folder and the ${countLabel(inside, 'file')} in it will be deleted from ${deletedFrom}.${serverPlace ? ' Hidden files in it, such as .git, go with it.' : ''} ${undone}`
            : `It will be deleted from ${deletedFrom}. ${undone}`,
        confirmLabel: 'Delete',
        danger: true,
        onConfirm: () => {
          setDialog(null);
          void (async () => {
            const done = removing(path);
            // What the open files under it are writing lands first, and
            // nothing more is written there, so nothing comes back.
            const release = currentId ? await holdWrites(currentId, path, { flush: false }) : () => {};
            try {
              await store.remove(path);
            } finally {
              release();
              done();
            }
            dispatch({ type: 'removed', path });
            setMeta((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !isInside(key, path))));
            await refresh();
            notify(`Deleted “${shown}”.`);
          })().catch(fail('Couldn’t delete it'));
        },
      });
    },
    [entryByPath, store, entries, deletedFrom, folderName, serverPlace, currentId, removing, dispatch, refresh, notify, fail],
  );

  const sizeByPath = useMemo(() => new Map(entries.flatMap((entry) => (entry.type === 'file' ? [[entry.path, entry.size ?? 0] as const] : []))), [entries]);

  /** Convert image… replacing an original: its tab, star and place follow it to the new file, before the original goes. */
  const followConverted = useCallback(
    (from: string, to: string) => {
      dispatch({ type: 'renamed', from, to });
      moveMeta(from, to);
    },
    [dispatch, moveMeta],
  );

  /** After Convert images: the status line says what was converted, then,
   * once the notes that link to a replaced image have followed it (one run
   * for the whole batch, as a rename's is), how many links did. The
   * conversion's own words never wait for it. */
  const finishConvert = useCallback(
    async (outcomes: ConvertOutcome[], single: boolean) => {
      await refresh();
      const converted = describeConversions(outcomes, { folder: !single });
      notify(converted);
      const first = outcomes.find((outcome) => outcome.status === 'converted');
      if (single && first?.status === 'converted') requestFocus(first.to);
      const moves = replacedMoves(outcomes);
      if (!store || !currentId || moves.length === 0) return;
      const scope = currentId;
      updateLinksAfterMoves(store, moves, { unsaved: (path) => hasUnsavedAt(scope, path) }).then(
        (run) => {
          const said = linkRunMessage(run);
          if (said) notify(`${converted} ${said}`);
        },
        (reason: unknown) => console.error('Nebula: links weren’t updated after converting', reason),
      );
    },
    [store, currentId, refresh, notify, requestFocus],
  );

  /* ---- projects ----------------------------------------------------- */

  const closeOverlays = useCallback(() => {
    setMenuOpen(false);
    setProjectMenu(null);
    setFileMenu(null);
    setTabMenu(null);
    setNewMenu(null);
  }, []);

  const switchProject = useCallback(
    (id: string) => {
      closeOverlays();
      setPaletteOpen(false);
      setSheet(false);
      setCurrentId(id);
    },
    [closeOverlays],
  );

  const createProject = useCallback(
    async (input: { name: string; color: string; folder?: FolderHandle }) => {
      const created = await registry.create(input);
      await reloadProjects();
      setCurrentId(created.id);
      return created;
    },
    [registry, reloadProjects],
  );

  /** New project's Create: in this browser, or in a folder picked now (from
   * the click). Cancelling the picker leaves the dialog as it was. */
  const createFromDialog = useCallback(
    (input: { name: string; color: string; where: ProjectHome }) => {
      if (input.where === 'browser') {
        setDialog(null);
        void createProject({ name: input.name, color: input.color }).catch(fail('Couldn’t make the project'));
        return;
      }
      void (async () => {
        const folder = await folders.pick();
        if (!folder) return;
        setDialog(null);
        const created = await createProject({ name: input.name, color: input.color, folder });
        if (created.name !== input.name) notify(`‘${folder.name}’ was already the Nebula project ${created.name}, so it opened as it was.`);
      })().catch(fail('Couldn’t make the project'));
    },
    [createProject, folders, notify, fail],
  );

  /** Move to a folder…, in Settings: the open browser project's files go to
   * an empty folder picked now, and the project with them (the registry
   * copies, checks each file, and only then deletes the browser copy). What
   * the open files have unsaved is written first, and their writes wait. */
  const moveProjectToFolder = useCallback(() => {
    if (!project || project.tier !== 'browser') return;
    const moving = project;
    void (async () => {
      const folder = await folders.pick();
      if (!folder) return;
      notify(`Moving ${moving.name} to the folder ‘${folder.name}’…`);
      setMovingHere(true);
      // Every write of the project's, not only the open files' (S3): new
      // notes, uploads and workspace.json wait too.
      const release = await holdWrites(moving.id, '');
      try {
        await registry.create({ name: moving.name, color: moving.color, folder, from: moving.id });
      } finally {
        release();
        setMovingHere(false);
      }
      await reloadProjects();
      notify(`Moved ${moving.name} to the folder ‘${folder.name}’. Its copy in this browser is deleted.`);
    })().catch(fail('Couldn’t move the project'));
  }, [project, folders, registry, reloadProjects, notify, fail]);

  /** Open a folder…: the folder as a project named after it, or the project
   * it already is. Cancelling the picker changes nothing. */
  const openFolder = useCallback(() => {
    closeOverlays();
    setPaletteOpen(false);
    setSheet(false);
    void (async () => {
      const folder = await folders.pick();
      if (!folder) return;
      await createProject({ name: folder.name, color: nextColour(projects), folder });
    })().catch(fail('Couldn’t open the folder'));
  }, [closeOverlays, folders, createProject, projects, fail]);

  const updateProject = useCallback(
    async (id: string, patch: { name?: string; color?: string }) => {
      setProjectList((list) => list?.map((record) => (record.id === id ? { ...record, ...patch } : record)) ?? list);
      await registry.update(id, patch);
      await reloadProjects();
    },
    [registry, reloadProjects],
  );

  const renameProject = useCallback(
    (id: string) => {
      const record = projects.find((item) => item.id === id);
      if (!record || listLocked) return;
      closeOverlays();
      setDialog({
        type: 'prompt',
        title: 'Rename project',
        label: 'Name',
        initialValue: record.name,
        confirmLabel: 'Rename',
        onSubmit: (name) => {
          setDialog(null);
          void updateProject(id, { name }).catch(fail('Couldn’t rename the project'));
        },
      });
    },
    [projects, listLocked, closeOverlays, updateProject, fail],
  );

  const removeProject = useCallback(
    (id: string) => {
      const record = projects.find((item) => item.id === id);
      if (!record || listLocked) return;
      closeOverlays();
      if (record.tier === 'server') {
        // Its folder is on the server, which lists it while it's there.
        notify(`${record.name} lives on ${record.server?.label ?? 'the server'}. To remove it, remove its folder there.`);
        return;
      }
      if (record.tier === 'folder') {
        // Forgotten, never deleted: the folder and its files stay put.
        const folder = record.folder?.name ?? record.name;
        setDialog({
          type: 'confirm',
          title: `Remove “${record.name}” from Nebula?`,
          body: `Nebula forgets this project. It never deletes the folder ‘${folder}’ or the files in it: they stay on this computer.`,
          confirmLabel: 'Remove from Nebula',
          onConfirm: () => {
            setDialog(null);
            setSettingsTab(null);
            void (async () => {
              await registry.remove(id);
              const list = await reloadProjects();
              if (id === currentId) setCurrentId([...list].sort(byCreated)[0]?.id ?? null);
              notify(`Removed “${record.name}” from Nebula. Its folder is where it was.`);
            })().catch(fail('Couldn’t remove the project'));
          },
        });
        return;
      }
      const where = persistent ? 'this browser' : 'this tab';
      const what = id === currentId ? `its ${countLabel(files.length, 'file')}` : 'all its files';
      setDialog({
        type: 'confirm',
        title: `Remove “${record.name}”?`,
        body: `This deletes ${record.name} and ${what} from ${where}.${downloadProject ? ' Download it first if you might want it back.' : ''} This can’t be undone.`,
        confirmLabel: 'Remove project',
        danger: true,
        onConfirm: () => {
          setDialog(null);
          setSettingsTab(null);
          void (async () => {
            await registry.remove(id);
            const list = await reloadProjects();
            if (id === currentId) setCurrentId([...list].sort(byCreated)[0]?.id ?? null);
            notify(`Removed “${record.name}”.`);
          })().catch(fail('Couldn’t remove the project'));
        },
      });
    },
    [projects, listLocked, closeOverlays, persistent, currentId, files.length, downloadProject, registry, reloadProjects, notify, fail],
  );

  // When the open project was last downloaded from this browser, for Settings.
  const [downloads, noteDownload] = useReducer((count: number) => count + 1, 0);
  const [downloadedAt, setDownloadedAt] = useState<number | null>(null);
  useEffect(() => {
    setDownloadedAt(currentId ? lastDownloaded(currentId) : null);
  }, [currentId, downloads]);

  const runDownloadProject = useCallback(
    (id: string) => {
      closeOverlays();
      if (!downloadProject) return;
      notify('Preparing the .zip…');
      void downloadProject(id).then(() => {
        setMessage(null);
        recordDownload(id);
        noteDownload();
      }, fail('Couldn’t download the project'));
    },
    [closeOverlays, downloadProject, notify, fail],
  );

  const openProjectSettings = useCallback(
    (id: string) => {
      closeOverlays();
      if (id !== currentId) switchProject(id);
      showSettingsTab('project');
    },
    [closeOverlays, currentId, switchProject, showSettingsTab],
  );

  const importOlderTab = useCallback(
    (canvas: OlderTabCanvas) => {
      if (!olderTabCanvases) return;
      // Into the project its earlier version went to, else the open one.
      const target = projects.find((record) => record.id === canvas.projectId) ?? project;
      if (!target) return;
      void olderTabCanvases
        .importCopy(canvas.key, target.id)
        .then(async (path) => {
          setOlderTab((current) => current.filter((item) => item.key !== canvas.key));
          notify(`Imported “${canvas.name}” into ${target.name} as ‘${describeName(basename(path)).label}’.`);
          if (target.id !== currentId) return;
          await refresh();
          openFile(path);
        })
        .catch(fail(`Couldn’t import “${canvas.name}”`));
    },
    [olderTabCanvases, projects, project, currentId, notify, refresh, openFile, fail],
  );

  const openNewProject = useCallback(() => {
    if (listLocked) return;
    closeOverlays();
    setPaletteOpen(false);
    setSheet(false);
    setDialog({ type: 'newProject' });
  }, [listLocked, closeOverlays]);

  /** The bar's button when the browser forgot a folder's permission: it
   * asks again (a prompt, so from this click). */
  const askForFolder = useCallback(() => {
    if (!project) return;
    void folders
      .request(project.id)
      .then(() => reloadProjects())
      .catch(fail('Couldn’t open the folder'));
  }, [project, folders, reloadProjects, fail]);

  /** The bar's button when a folder can't be opened: choose it again. The
   * same folder (moved, or picked again) is the same project; another
   * folder opens as a project of its own. Cancelling changes nothing. */
  const chooseFolderAgain = useCallback(() => {
    if (!project) return;
    const wanted = project;
    void (async () => {
      const handle = await folders.pick();
      if (!handle) return;
      const record = await registry.create({ name: wanted.name, color: wanted.color, folder: handle });
      await reloadProjects();
      if (record.id === wanted.id && heldOpen === wanted.id) {
        setReopened((count) => count + 1);
        setHeldOpen(null);
      }
      if (record.id !== wanted.id) {
        setCurrentId(record.id);
        notify(`‘${handle.name}’ isn’t the folder ${wanted.name} was in, so it opened as a project of its own.`);
      }
    })().catch(fail('Couldn’t open the folder'));
  }, [project, folders, registry, reloadProjects, notify, fail, heldOpen]);

  // "Saved in this browser" is true in a private window too, which can't be
  // told apart; Settings says what the browser has promised, and the rail's status says when it hasn't. Read when the workspace
  // opens, when Settings opens, when an edit asks the browser (keepOnEdit) and
  // when the page comes back into view; only the latest read counts.
  const settingsOpen = settingsTab !== null;
  useEffect(() => {
    if (!persistent) return;
    let cancelled = false;
    let latest = 0;
    const read = () => {
      const n = ++latest;
      void storageStatus().then((status) => {
        if (!cancelled && n === latest) setKept(status.persisted);
      });
    };
    read();
    const stop = onPersistenceAnswer(read);
    const onVisible = () => {
      if (document.visibilityState === 'visible') read();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [settingsOpen, persistent]);
  // false: it hasn't promised; null: it can't say. Either way, may be cleared.
  // A folder can't be cleared by the browser: its status stays calm.
  const attention = persistent && !folderName && !serverPlace && (kept === false || kept === null);

  /* ---- shortcuts ---------------------------------------------------- */

  const toggleRail = useCallback(() => {
    if (phone) setSheet((open) => !open);
    else setCollapsed((folded) => !folded);
  }, [phone]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !hasMod(event) || event.altKey) return;
      const modal = document.querySelector('dialog[open]:not(.ws-palette), .ws-settings[aria-modal="true"]');
      if (event.key.toLowerCase() === 'k' && !event.shiftKey) {
        if (modal) return;
        event.preventDefault();
        closeOverlays();
        setPaletteOpen((open) => !open);
      } else if (event.key === '\\' || event.code === 'Backslash') {
        if (modal) return;
        event.preventDefault();
        toggleRail();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeOverlays, toggleRail]);

  // The phone's file sheet: Escape or the scrim close it; focus goes in and
  // comes back.
  const sheetOpen = phone && sheet;
  useEscapeLayer(sheetOpen, () => setSheet(false));
  const sheetReturn = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!sheetOpen) return;
    sheetReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      const target =
        document.querySelector<HTMLElement>('.ws-filetree [role="treeitem"][tabindex="0"]') ??
        document.querySelector<HTMLElement>('.ws-switcher');
      target?.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      const back = sheetReturn.current;
      const active = document.activeElement;
      if (back?.isConnected && (!active || active === document.body || active.closest('.ws-rail'))) back.focus({ preventScroll: true });
    };
  }, [sheetOpen]);

  /* ---- the outline --------------------------------------------------- */

  const outlineKey = activeEntry && activeKind === 'note' ? `${activeEntry.path}:${activeEntry.size}:${activeEntry.modified}` : null;
  useEffect(() => {
    if (!panelOpen || !store || !outlineKey || !activeEntry) return;
    let cancelled = false;
    store
      .readText(activeEntry.path)
      .then((text) => {
        if (!cancelled) setOutline(extractOutline(text));
      })
      .catch(() => {
        if (!cancelled) setOutline([]);
      });
    return () => {
      cancelled = true;
    };
    // outlineKey changes whenever the note does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen, store, outlineKey]);

  /* ---- menus --------------------------------------------------------- */

  const act = (action: () => void) => () => {
    closeOverlays();
    action();
  };

  const fileMenuEntries = (path: string | null): MenuEntry[] => {
    const creating = (folder: string): MenuEntry[] => [
      { label: 'New note', icon: 'note-plus', onSelect: act(() => newNote(folder)) },
      { label: 'Paste as note', icon: 'paste', onSelect: act(() => pasteAsNote(folder)) },
      { label: 'New canvas', icon: 'canvas-plus', onSelect: act(() => newCanvas(folder)) },
      { label: 'New folder', icon: 'folder-plus', onSelect: act(() => newFolder(folder)) },
      { label: 'Upload files…', icon: 'upload', onSelect: act(() => pickUpload(folder)) },
    ];
    if (path === null) return creating('');
    const entry = entryByPath.get(path);
    if (!entry || !store) return [];
    const isStarred = ws.starred.includes(path);
    const common: MenuEntry[] = [
      { label: 'Rename…', icon: 'pencil', shortcut: 'F2', keys: 'F2', onSelect: act(() => setRenaming(path)) },
      { label: isStarred ? 'Unstar' : 'Star', icon: 'star', onSelect: act(() => dispatch({ type: 'toggleStar', path })) },
      ...(linkTo ? [{ label: 'Copy link', icon: 'link' as const, onSelect: act(() => copyLink(path)) }] : []),
    ];
    const remove: MenuEntry = { label: 'Delete…', icon: 'trash', danger: true, shortcut: 'Del', keys: 'Delete', onSelect: act(() => confirmDelete(path)) };
    if (entry.type === 'dir') {
      const images = entries.filter((other) => other.type === 'file' && isInside(other.path, path) && isConvertible(other.name)).map((other) => other.path);
      const convert: MenuEntry[] =
        images.length > 0 ? [{ label: 'Convert images…', icon: 'image', disabled: convertWait !== null, onSelect: act(() => setDialog({ type: 'convert', paths: images, folder: path })) }] : [];
      return [...creating(path), 'separator', ...common, ...convert, 'separator', remove];
    }
    const canvas = iconKind(path) === 'canvas';
    return [
      { label: 'Open', icon: 'open', onSelect: act(() => openFile(path)) },
      ...common,
      'separator',
      ...(isConvertible(entry.name)
        ? [{ label: 'Convert image…', icon: 'image' as const, disabled: convertWait !== null, onSelect: act(() => setDialog({ type: 'convert', paths: [path], folder: null })) }]
        : []),
      { label: 'Download', icon: 'download', onSelect: act(() => void downloadFile(store, entry).catch(fail('Couldn’t download it'))) },
      ...(canvas
        ? [
            {
              label: 'Download as .excalidraw',
              icon: 'download' as const,
              onSelect: act(() => void downloadAsExcalidraw(store, entry).catch(fail('Couldn’t export the canvas'))),
            },
          ]
        : []),
      'separator',
      remove,
    ];
  };

  const tabMenuEntries = (path: string): MenuEntry[] => [
    { label: 'Close', icon: 'close', onSelect: act(() => closeTab(path)) },
    {
      label: 'Close others',
      onSelect: act(() => {
        for (const tab of ws.tabs) if (tab !== path) closeTab(tab);
      }),
    },
    'separator',
    {
      label: 'Show in files',
      icon: 'files',
      onSelect: act(() => showInFiles(path)),
    },
    ...(linkTo ? [{ label: 'Copy link', icon: 'link' as const, onSelect: act(() => copyLink(path)) }] : []),
  ];

  /* ---- intro --------------------------------------------------------- */

  const introOpen = intro !== null && !introDone && sessionReady;
  const finishIntro = useCallback(() => {
    setIntroDone(true);
    onIntroDone?.();
  }, [onIntroDone]);

  /* ---- render -------------------------------------------------------- */

  const projectForMenu = projectMenu ? (projects.find((record) => record.id === projectMenu.id) ?? null) : null;
  const activeMeta = ws.active ? meta[ws.active] : undefined;
  const oneProject = projects.length === 1;

  const emptyStage = blocked && project ? (
    <div className="ws-empty">
      <h2>{project.name}</h2>
      <p>Its files are in the folder ‘{blocked.name}’ on this computer.</p>
    </div>
  ) : !project ? (
    <div className="ws-empty">
      <h2>{projectList === null ? 'Opening Nebula…' : 'No projects yet'}</h2>
      {projectList === null ? null : (
        <>
          <p>A project keeps notes, drawings and files together.</p>
          <div className="ws-set-actions">
            <Button className="welcome-dialog-cta ws-cta" disabled={listLocked} onClick={openNewProject}>
              New project
            </Button>
          </div>
        </>
      )}
    </div>
  ) : (
    <div className="ws-empty">
      <h2>{sessionReady ? 'Nothing open' : `Opening ${project.name}…`}</h2>
      {sessionReady ? (
        <>
          <p>{files.length ? 'Open a file from the list, or start something new.' : 'Start with a note or a canvas, or bring in files you have.'}</p>
          <div className="ws-set-actions">
            <Button className="ws-btn" onClick={() => newNote()}>
              <Icon name="note-plus" />
              New note
            </Button>
            <Button className="ws-btn" onClick={() => newCanvas()}>
              <Icon name="canvas-plus" />
              New canvas
            </Button>
            <Button className="ws-btn" onClick={() => pickUpload()}>
              <Icon name="upload" />
              Upload files
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );

  const phoneTitle = activeEntry ? describeName(activeEntry.name).label : (project?.name ?? 'Nebula');

  return (
    <div
      className="ws-root"
      data-night={night ? '' : undefined}
      data-dock-shown={dockShown ? '' : undefined}
      data-sheet={sheetOpen ? '' : undefined}
    >
      <div className="ws page-sidebar-app" data-collapsed={collapsed && !phone ? '' : undefined} inert={settingsTab !== null}>
        {dockShown ? (
          <nav className="ws-dock" aria-label="Projects">
            <img className="ws-dock-logo" src={NEBULA_LOGO_SRC} alt="Nebula" width={40} height={34} />
            <span className="ws-dock-sep" aria-hidden="true" />
            {projects.map((record) => (
              <Button
                key={record.id}
                className="ws-planet"
                style={{ '--planet': record.color } as CSSProperties}
                aria-label={record.name}
                aria-current={record.id === currentId ? 'true' : undefined}
                title={record.name}
                onClick={() => switchProject(record.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setProjectMenu({ id: record.id, at: { x: event.clientX, y: event.clientY }, fromSwitcher: false });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                    event.preventDefault();
                    setProjectMenu({ id: record.id, at: menuAtElement(event.currentTarget), fromSwitcher: false });
                  }
                }}
              />
            ))}
            <Button className="ws-dock-add" aria-label="New project" title="New project" disabled={listLocked} onClick={openNewProject}>
              <Icon name="plus" />
            </Button>
          </nav>
        ) : null}

        <Rail
          project={project}
          oneProject={oneProject}
          location={location}
          usage={usage}
          ephemeral={!persistent}
          attention={attention}
          folderName={folderName ?? serverPlace?.folder ?? null}
          placeLabel={serverPlace ? `On ${serverPlace.label}` : null}
          blocked={folderBar ? (folderBar.access === 'prompt' ? 'Needs your OK' : folderBar.access === 'denied' ? 'Not allowed' : 'Can’t be found') : isMoving ? 'Moving to a folder…' : null}
          night={night}
          collapsed={collapsed && !phone}
          menuOpen={menuOpen}
          contextOpen={projectMenu?.fromSwitcher === true}
          switcherRef={switcherRef}
          starred={starred}
          activePath={ws.active}
          searchShortcut={shortcutLabel('K')}
          collapseShortcut={shortcutLabel('\\')}
          onSwitcher={() => {
            setProjectMenu(null);
            setMenuOpen((open) => !open);
          }}
          onSwitcherMenu={(at) => {
            if (!project) return;
            setMenuOpen(false);
            setProjectMenu({ id: project.id, at, fromSwitcher: true });
          }}
          onRenameProject={() => project && renameProject(project.id)}
          onSearch={() => {
            closeOverlays();
            setSheet(false);
            setPaletteOpen(true);
          }}
          onNewNote={() => newNote()}
          onNewCanvas={() => newCanvas()}
          onNewFolder={() => newFolder()}
          onUpload={() => pickUpload()}
          onOpenStarred={(path) => {
            const entry = entryByPath.get(path);
            if (entry?.type === 'dir') {
              dispatch({ type: 'reveal', path });
              dispatch({ type: 'setExpanded', path, expanded: true });
              requestFocus(path);
            } else openFile(path);
          }}
          onStarredMenu={(path, at) => setFileMenu({ path, at })}
          onToggleTheme={() => theme.setMode(night ? 'light' : 'dark')}
          onSettings={() => {
            closeOverlays();
            setSheet(false);
            setSettingsTab(project ? lastSettingsTab : 'appearance');
          }}
          onWhere={
            project
              ? () => {
                  closeOverlays();
                  setSheet(false);
                  showSettingsTab('project');
                }
              : undefined
          }
          onHelp={() => {
            closeOverlays();
            if (onHelp) onHelp();
            else setAboutOpen(true);
          }}
          onToggleCollapsed={toggleRail}
          tree={{
            tree,
            ...(blocked ? { emptyText: 'Its files show here once Nebula can open the folder.' } : {}),
            expanded,
            activePath: ws.active,
            kinds,
            renaming,
            focusRequest,
            onOpen: openFile,
            onToggle: (path) => dispatch({ type: 'toggleExpanded', path }),
            onExpand: (path, open) => dispatch({ type: 'setExpanded', path, expanded: open }),
            onStartRename: setRenaming,
            onRename: renameEntry,
            onCancelRename: () => {
              const path = renaming;
              setRenaming(null);
              if (path) requestFocus(path);
            },
            onDelete: confirmDelete,
            onMenu: (path, at) => setFileMenu({ path, at }),
            onMove: (from, folder) => void moveEntry(from, folder).catch(fail('Couldn’t move it')),
            onDropFiles: (list, folder) => void uploadFiles(list, folder).catch(fail('Couldn’t add the files')),
          }}
        />

        <main className="page-sidebar-main ws-main" inert={sheetOpen}>
          <header className="ws-phone-top">
            <Button className="ws-icon-btn" aria-label="Files" aria-expanded={sheetOpen} onClick={() => setSheet(true)}>
              <Icon name="menu" />
            </Button>
            <span className="ws-phone-title">
              {oneProject || !project ? (
                <img className="ws-phone-logo" src={NEBULA_LOGO_SRC} alt="" width={22} height={19} />
              ) : (
                <Planet color={project.color} />
              )}
              <span>{phoneTitle}</span>
            </span>
            <Button className="ws-icon-btn" aria-label="Search" onClick={() => setPaletteOpen(true)}>
              <Icon name="search" />
            </Button>
          </header>

          {project ? (
            <Tabs
              tabs={ws.tabs}
              active={ws.active}
              kinds={kinds}
              meta={meta}
              panelOpen={panelOpen}
              onActivate={(path) => dispatch({ type: 'activate', path })}
              onClose={closeTab}
              onMove={(path, to) => dispatch({ type: 'moveTab', path, to })}
              onNewNote={() => newNote()}
              onTogglePanel={() => setPanelOpen((open) => !open)}
              onMenu={(path, at) => setTabMenu({ path, at })}
            />
          ) : null}

          {notice ? (
            <div className="ws-ephemeral ws-notice" role="alert">
              <span className="ws-store-dot" data-ephemeral="" aria-hidden="true" />
              <p>{notice}</p>
            </div>
          ) : null}

          {keptCopies.map((item) => (
            <div key={item.key} className="ws-ephemeral ws-kept" role="note">
              <span className="ws-store-dot" data-ephemeral="" aria-hidden="true" />
              <p>{item.text}</p>
              {item.copy && item.projectId === currentId ? (
                <Button
                  className="ws-btn"
                  aria-label="Open the copy"
                  onClick={() => {
                    dismissKept(item);
                    openFile(item.copy!);
                  }}
                >
                  Open
                </Button>
              ) : null}
              {item.download ? (
                <Button className="ws-btn" aria-label={`Download your changes to ${item.name}`} onClick={() => downloadKept(item)}>
                  Download
                </Button>
              ) : null}
              <Button className="ws-icon-btn" aria-label="Dismiss" onClick={() => dismissKept(item)}>
                <Icon name="close" />
              </Button>
            </div>
          ))}

          {/* Once the open project has settled, so an import opens on top of it. */}
          {olderTab.length > 0 && olderTabCanvases && projectList !== null && (sessionReady || !project) ? (
            <div className="ws-ephemeral ws-older" role="note">
              <span className="ws-store-dot" data-attention="" aria-hidden="true" />
              <div className="ws-older-body">
                <p>Canvases saved by an older Nebula tab after the move</p>
                <ul className="ws-left-behind">
                  {olderTab.map((canvas) => (
                    <li key={canvas.key}>
                      <span>{canvas.name}</span>
                      <Button
                        className="ws-btn"
                        aria-label={`Import “${canvas.name}” as a copy`}
                        disabled={!project && !projects.some((record) => record.id === canvas.projectId)}
                        onClick={() => importOlderTab(canvas)}
                      >
                        Import as a copy
                      </Button>
                      <Button className="ws-btn" aria-label={`Download “${canvas.name}” as .excalidraw`} onClick={() => olderTabCanvases.download(canvas.key)}>
                        Download
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
              <Button
                className="ws-icon-btn"
                aria-label="Dismiss"
                onClick={() => {
                  olderTabCanvases.dismiss?.(olderTab);
                  setOlderTab([]);
                }}
              >
                <Icon name="close" />
              </Button>
            </div>
          ) : null}

          {!folderBar && session.projectId === currentId && session.tooBig !== null ? (
            <div className="ws-ephemeral ws-folder-bar" role="note">
              <span className="ws-store-dot" data-attention="" aria-hidden="true" />
              <p>{folderTooBigMessage(session.tooBig || project?.folder?.name || '')} Changes made outside Nebula show once you reload.</p>
            </div>
          ) : null}

          {folderBar ? (
            <div className="ws-ephemeral ws-folder-bar" role="note">
              <span className="ws-store-dot" data-attention="" aria-hidden="true" />
              <p>
                {folderBar.access === 'prompt'
                  ? `Nebula needs your OK to open the folder ‘${folderBar.name}’ again.`
                  : folderBar.access === 'denied'
                    ? `Nebula isn’t allowed to open the folder ‘${folderBar.name}’.`
                    : `Nebula can’t find the folder ‘${folderBar.name}’. It may have been moved, renamed or deleted, or be on a drive that isn’t connected.`}
              </p>
              {folderBar.access === 'prompt' ? (
                <Button className="ws-btn" onClick={askForFolder}>
                  <Icon name="folder" />
                  Open the folder
                </Button>
              ) : (
                <Button className="ws-btn" onClick={chooseFolderAgain}>
                  <Icon name="folder" />
                  Choose the folder again
                </Button>
              )}
            </div>
          ) : null}

          {listLocked ? (
            <div className="ws-ephemeral ws-readonly" role="note">
              <span className="ws-store-dot" data-attention="" aria-hidden="true" />
              <p>These projects were saved by a newer version of Nebula, so this one can open them but not change the project list.</p>
            </div>
          ) : null}

          {!persistent ? (
            <div className="ws-ephemeral" role="note">
              <span className="ws-store-dot" data-ephemeral="" aria-hidden="true" />
              <p>This browser won’t keep files here, so they’ll be gone when you close this tab.</p>
              {downloadProject && project ? (
                <Button className="ws-btn" onClick={() => runDownloadProject(project.id)}>
                  <Icon name="download" />
                  Download
                </Button>
              ) : null}
            </div>
          ) : null}

          {/* The project index, for the panel and the views. */}
          <ProjectIndexProvider source={projectIndex}>
          {/* The links' project (opening a file, at a line) for the stage and for the panel's Linked from. */}
          <ProjectLinksContext.Provider value={projectLinks}>
          <div className="ws-body">
            <PageWidthContext.Provider value={pageWidth}>
              <Stage
                viewFor={viewFor}
                projectId={currentId ?? ''}
                store={store}
                entry={sessionReady ? activeEntry : null}
                kind={activeKind}
                labelledBy={ws.active ? tabId(ws.active) : undefined}
                empty={emptyStage}
                onStatus={onStatus}
                onDirty={onDirty}
                onOpenAs={openAs}
                jump={jump}
              />
            </PageWidthContext.Provider>
            {panelOpen && !phone ? <OutlinePanel headings={outline} isNote={activeKind === 'note'} path={sessionReady ? ws.active : null} /> : null}
          </div>
          </ProjectLinksContext.Provider>
          </ProjectIndexProvider>

          <StatusLine ephemeral={!persistent} inFolder={folderName !== null} place={serverPlace?.label ?? null} folderClosed={folderBar !== null} saving={activeMeta?.dirty === true} status={activeMeta?.status ?? null} message={message} />

          <nav className="ws-phone-bar" aria-label="Phone">
            <Button aria-expanded={sheetOpen} onClick={() => setSheet(true)}>
              <Icon name="files" />
              Files
            </Button>
            <Button onClick={() => setPaletteOpen(true)}>
              <Icon name="search" />
              Search
            </Button>
            {/* Nothing to add to while the folder can't be opened (the rail hides its own). */}
            {folderBar || isMoving ? null : (
              <Button
                className="ws-phone-new"
                aria-label="New"
                aria-haspopup="menu"
                aria-expanded={newMenu !== null}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setNewMenu(newMenu ? null : { x: rect.left - 60, y: rect.top - 200 });
                }}
              >
                <Icon name="plus" />
              </Button>
            )}
            <Button onClick={() => setSettingsTab(project ? lastSettingsTab : 'appearance')}>
              <Icon name="gear" />
              Settings
            </Button>
          </nav>
        </main>

        <div className="ws-scrim" aria-hidden="true" onClick={() => setSheet(false)} />
      </div>

      <div className="ws-visually-hidden" role="status" aria-live="polite">
        {message}
      </div>

      <input ref={uploadInput} type="file" multiple hidden tabIndex={-1} aria-hidden="true" onChange={onUploadChange} />

      <ProjectMenu
        open={menuOpen}
        projects={projects}
        currentId={currentId}
        location={locationOf}
        dock={preferences.dock}
        anchor={switcherRef}
        onDockChange={(on) => setPreference('dock', on)}
        onSwitch={switchProject}
        onNewProject={openNewProject}
        canCreate={!listLocked}
        onOpenFolder={canUseFolders ? openFolder : undefined}
        onProjectMenu={(id, at) => setProjectMenu({ id, at, fromSwitcher: false })}
        onClose={() => setMenuOpen(false)}
      />

      <ProjectContextMenu
        project={projectForMenu}
        at={projectMenu?.at ?? null}
        canDownload={downloadProject !== undefined}
        canChange={!listLocked}
        onColour={(colour) => projectForMenu && void updateProject(projectForMenu.id, { color: colour }).catch(fail('Couldn’t change the colour'))}
        onRename={() => projectForMenu && renameProject(projectForMenu.id)}
        onSettings={() => projectForMenu && openProjectSettings(projectForMenu.id)}
        onDownload={() => projectForMenu && runDownloadProject(projectForMenu.id)}
        onRemove={() => projectForMenu && removeProject(projectForMenu.id)}
        onClose={() => setProjectMenu(null)}
      />

      <WsContextMenu at={fileMenu?.at ?? null} onClose={() => setFileMenu(null)} label="File" className="ws-filemenu">
        {fileMenu ? <MenuEntries entries={fileMenuEntries(fileMenu.path)} /> : null}
      </WsContextMenu>

      <WsContextMenu at={tabMenu?.at ?? null} onClose={() => setTabMenu(null)} label="Tab" className="ws-filemenu">
        {tabMenu ? <MenuEntries entries={tabMenuEntries(tabMenu.path)} /> : null}
      </WsContextMenu>

      <WsContextMenu at={newMenu} onClose={() => setNewMenu(null)} label="New" className="ws-filemenu">
        {newMenu ? <MenuEntries entries={fileMenuEntries(null)} /> : null}
      </WsContextMenu>

      {/* Quick open searches the notes and canvases too: the same index as the panel's. */}
      <ProjectIndexProvider source={projectIndex}>
        <QuickOpen
          open={paletteOpen}
          initialQuery={paletteQuery}
          entries={files}
          kinds={kinds}
          projects={projects}
          currentId={currentId}
          location={locationOf}
          onOpenFile={(path) => {
            setPaletteOpen(false);
            openFile(path);
          }}
          onOpenAt={(path, place) => {
            setPaletteOpen(false);
            openLinked(path, undefined, place);
          }}
          onSwitchProject={(id) => {
            setPaletteOpen(false);
            switchProject(id);
          }}
          onClose={() => setPaletteOpen(false)}
        />
      </ProjectIndexProvider>

      <SettingsDrawer
        open={settingsTab !== null}
        tab={settingsTab ?? 'appearance'}
        onTab={showSettingsTab}
        onClose={() => setSettingsTab(null)}
        themeMode={theme.mode}
        resolvedTheme={theme.resolved}
        onThemeMode={theme.setMode}
        backdrop={backdrop}
        motion={motion.enabled}
        onMotion={motion.setEnabled}
        preferences={preferences}
        onPreference={setPreference}
        projectCount={projects.length}
        project={project}
        location={location}
        usage={usage}
        fileCount={files.length}
        ephemeral={!persistent}
        folderName={folderName}
        serverPlace={serverPlace}
        kept={kept}
        // A .zip is a browser project's safety net; a folder's files are already on this computer.
        downloaded={folderName === null && serverPlace === null ? downloadedLabel(downloadedAt) : null}
        canDownload={downloadProject !== undefined}
        canChangeProject={!listLocked}
        onRename={(name) => project && void updateProject(project.id, { name }).catch(fail('Couldn’t rename the project'))}
        onColour={(colour) => project && void updateProject(project.id, { color: colour }).catch(fail('Couldn’t change the colour'))}
        onDownload={() => project && runDownloadProject(project.id)}
        onImport={() => pickUpload('')}
        onRemove={() => project && removeProject(project.id)}
        onMoveToFolder={canUseFolders && project?.tier === 'browser' ? moveProjectToFolder : undefined}
      />

      {dialog?.type === 'newProject' ? (
        <NewProjectDialog
          open
          persistent={persistent}
          initialColour={nextColour(projects)}
          defaultName={dialog.first || projects.length === 0 ? FIRST_PROJECT_NAME : undefined}
          canUseFolders={canUseFolders}
          onCancel={() => setDialog(null)}
          onCreate={createFromDialog}
        />
      ) : null}

      {dialog?.type === 'confirm' ? (
        <ConfirmDialog
          open
          title={dialog.title}
          body={dialog.body}
          confirmLabel={dialog.confirmLabel}
          danger={dialog.danger}
          onConfirm={dialog.onConfirm}
          onCancel={() => setDialog(null)}
        />
      ) : null}

      {dialog?.type === 'convert' && store ? (
        <ConvertImagesDialog
          open
          store={store}
          paths={dialog.paths}
          sizes={sizeByPath}
          folder={dialog.folder}
          tools={imageTools}
          waitReason={convertWait}
          onReplace={followConverted}
          onCancel={() => setDialog(null)}
          onDone={(outcomes) => {
            setDialog(null);
            void finishConvert(outcomes, dialog.folder === null).catch(fail('Couldn’t finish converting'));
          }}
        />
      ) : null}

      {dialog?.type === 'prompt' ? (
        <PromptDialog
          open
          title={dialog.title}
          label={dialog.label}
          initialValue={dialog.initialValue}
          confirmLabel={dialog.confirmLabel}
          onSubmit={dialog.onSubmit}
          onCancel={() => setDialog(null)}
        />
      ) : null}

      {introOpen && intro ? (
        <IntroDialog
          open
          variant={intro}
          leftBehind={intro === 'migrated' ? leftBehind : null}
          onDownloadLeftBehind={onDownloadLeftBehind}
          persistent={persistent}
          projectName={project?.name ?? 'Night Sky'}
          canDownload={downloadProject !== undefined}
          onExplore={finishIntro}
          onStartEmpty={() => {
            finishIntro();
            setDialog({ type: 'newProject', first: true });
          }}
        />
      ) : null}

      {onHelp ? null : <Help open={aboutOpen} persistent={persistent} canDownload={downloadProject !== undefined} canUseFolders={canUseFolders} onClose={() => setAboutOpen(false)} />}
    </div>
  );
}

