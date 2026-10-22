/**
 * How Nebula starts (docs/slice-3.md, Integration 2, decisions 5 and 8):
 *
 * 1. Open the browser tier (OPFS, or memory when this browser keeps nothing).
 * 2. When Nebula 1.x canvases are in localStorage and haven't moved yet, move
 *    them into projects (the migration loads only then).
 * 3. A brand-new visitor (no projects, nothing moved, never set up) gets the
 *    Night Sky sample and the welcome; someone whose canvases just moved gets
 *    the one-time note instead. Everyone else opens their last project.
 *
 * `nebula:setup` records that this browser has been set up, so removing every
 * project later shows the empty state rather than a new sample. When nothing
 * will be kept, the old canvases stay where they are and the sample is made
 * in memory, so a visitor can still look around.
 */
import type { MigrationInput, MigrationReport } from '../files/migration';
import type { BrowserRegistryHandle } from '../files/opfsRegistry';
import type { BrowserRegistry } from '../files/registry';
import type { SampleResult } from '../files/sample';

/** Nebula 1.x scenes: `nebula:excalidraw:<board>:<canvas>`. */
export const LEGACY_PREFIX = 'nebula:excalidraw:';
/** When this browser was first set up (ISO 8601). */
export const SETUP_KEY = 'nebula:setup';
/** The migration's marker (src/files/migration.ts; a test keeps them equal).
 * Repeated here so a visit that has nothing to move never loads that module. */
export const MIGRATION_MARKER_KEY = 'nebula:migration:v2';
/** Where each old canvas went, for old /b/… links: see readLegacyRoutes(). */
export const LEGACY_ROUTES_KEY = 'nebula:migration:routes';

const BOOT_LOCK = 'nebula:boot';

export type Intro = 'welcome' | 'migrated' | null;

export type BootDeps = {
  /** localStorage, or null when the browser blocks it. */
  storage: Storage | null;
  openRegistry: () => Promise<BrowserRegistryHandle>;
  /** migrateLegacyCanvases, loaded on demand. */
  migrate: (input: MigrationInput) => Promise<MigrationReport>;
  /** seedSampleProject, loaded on demand. */
  seed: (registry: BrowserRegistry) => Promise<SampleResult>;
  now?: () => Date;
};

export type Boot = {
  registry: BrowserRegistry;
  /** False when nothing will be kept (decision 8). */
  persistent: boolean;
  /** Why nothing will be kept. */
  reason?: string;
  intro: Intro;
  /** Something the workspace should say at once: old canvases that couldn't move. */
  notice: string | null;
  /** What the migration did on this visit, if it ran. */
  migration: MigrationReport | null;
  /** What a move on this visit didn't do, for its note (re-review R3):
   * canvases that stayed in localStorage, and anything else it warned of.
   * Null when everything moved. */
  leftBehind: LeftBehind | null;
};

export type LeftBehind = {
  /** Canvases that didn't read back the same, so they stayed where 1.x kept
   * them: the note names each and offers it as a download. */
  canvases: Array<{ key: string; name: string }>;
  /** The move's other warnings, said as they are. */
  warnings: string[];
};

/** What the note should say beyond 'moved': nothing when all went well. */
function leftBehindBy(report: MigrationReport): LeftBehind | null {
  const failed = report.failed ?? [];
  // A canvas left behind is warned about too; the note names it once.
  const named = failed.map((canvas) => `“${canvas.name}” (board ${canvas.boardId})`);
  const warnings = (report.warnings ?? []).filter((warning) => !named.some((name) => warning.startsWith(name)));
  if (failed.length === 0 && warnings.length === 0) return null;
  return { canvases: failed.map(({ key, name }) => ({ key, name })), warnings };
}

/** Board id → the project it became, and canvas id → its file there. */
export type LegacyRoutes = Record<string, { project: string; canvases: Record<string, string> }>;

function keys(storage: Storage): string[] {
  const found: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) found.push(key);
  }
  return found;
}

function read(storage: Storage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: Storage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // A full or blocked storage: the flag is lost, nothing else.
  }
}

/** True when Nebula 1.x left canvases in this browser. */
export function hasLegacyCanvases(storage: Storage | null): boolean {
  if (!storage) return false;
  try {
    return keys(storage).some((key) => key.startsWith(LEGACY_PREFIX));
  } catch {
    return false;
  }
}

/** Where each old canvas went, as recorded when it moved ({} when none did). */
export function readLegacyRoutes(storage: Storage | null): LegacyRoutes {
  const text = read(storage, LEGACY_ROUTES_KEY);
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const routes: LegacyRoutes = {};
    for (const [board, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const { project, canvases } = value as { project?: unknown; canvases?: unknown };
      if (typeof project !== 'string' || typeof canvases !== 'object' || canvases === null) continue;
      const files: Record<string, string> = {};
      for (const [canvas, path] of Object.entries(canvases as Record<string, unknown>)) if (typeof path === 'string') files[canvas] = path;
      routes[board] = { project, canvases: files };
    }
    return routes;
  } catch {
    return {};
  }
}

function recordLegacyRoutes(storage: Storage | null, report: MigrationReport): void {
  const routes: LegacyRoutes = { ...readLegacyRoutes(storage) };
  for (const project of report.projects) {
    routes[project.boardId] = {
      project: project.projectId,
      canvases: Object.fromEntries(project.files.map((file) => [file.canvasId, file.path])),
    };
  }
  write(storage, LEGACY_ROUTES_KEY, JSON.stringify(routes));
}

// Tabs opening at once must not both make a sample. Web Locks reach across
// tabs; without them (old browsers, tests) a queue in this page does.
let localQueue: Promise<unknown> = Promise.resolve();

function exclusively<T>(action: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks) return locks.request(BOOT_LOCK, action) as Promise<T>;
  const result = localQueue.then(action, action);
  localQueue = result.catch(() => {});
  return result;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export async function bootNebula(deps: BootDeps): Promise<Boot> {
  const { storage } = deps;
  const now = deps.now ?? (() => new Date());
  const { registry, persistent, reason } = await deps.openRegistry();

  return exclusively(async () => {
    const boot: Boot = { registry, persistent, intro: null, notice: null, migration: null, leftBehind: null };
    if (reason) boot.reason = reason;
    const setUp = read(storage, SETUP_KEY) !== null;

    if (!persistent) {
      // Nothing will be kept: old canvases wait for a browser that can keep
      // them, and the sample lives in this tab.
      try {
        await deps.seed(registry);
        if (!setUp) boot.intro = 'welcome';
      } catch (error) {
        console.error('Nebula could not make the sample project', error);
      }
      return boot;
    }

    if (storage && hasLegacyCanvases(storage) && read(storage, MIGRATION_MARKER_KEY) === null) {
      const report = await deps.migrate({ storage, registry, persistent });
      boot.migration = report;
      if (report.status === 'migrated') {
        recordLegacyRoutes(storage, report);
        write(storage, SETUP_KEY, now().toISOString());
        boot.intro = 'migrated';
        boot.leftBehind = leftBehindBy(report);
        return boot;
      }
      if (report.status === 'failed') {
        console.error('Nebula could not move the old canvases', report.error);
        boot.notice = `Nebula couldn’t move your canvases into projects (${report.error ?? 'unknown error'}). They’re still saved in this browser; reload to try again.`;
        return boot;
      }
    }

    const projects = await registry.list();
    if (projects.length > 0 || setUp) {
      if (!setUp) write(storage, SETUP_KEY, now().toISOString());
      return boot;
    }

    try {
      await deps.seed(registry);
      write(storage, SETUP_KEY, now().toISOString());
      boot.intro = 'welcome';
    } catch (error) {
      console.error('Nebula could not make the sample project', describe(error));
    }
    return boot;
  });
}
