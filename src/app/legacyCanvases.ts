/**
 * Nebula 1.x canvases still in localStorage, as files (re-review R3 and R6):
 * ones the migration left behind, and ones an older tab saved after the
 * move. Nothing here changes a 1.x key; the one key written is the record of
 * what the offer has done (OLDER_TAB_HANDLED_KEY).
 */
import { fitSegment, portableName, uniqueName } from '../files/paths';
import { hasLegacyCanvases } from './boot';
import type { BrowserRegistry } from '../files/registry';
import { normalizeExcalidrawScene } from '../nebula/excalidraw/scene';
import { isNebulaExcalidrawDocument, type NebulaExcalidrawDocument } from '../nebula/storage/types';

/** The 1.x document under `key`, or null when it holds none. */
export function readLegacyDocument(storage: Storage | null, key: string): NebulaExcalidrawDocument | null {
  let text: string | null;
  try {
    text = storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isNebulaExcalidrawDocument(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A file name's stem from a canvas name, as the migration makes them
 * ('Launch: map' → 'Launch- map'), and portable. */
export function canvasFileStem(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return portableName(cleaned || 'Untitled');
}

/** A 1.x canvas as an `.excalidraw` file (Excalidraw's JSON), which can be
 * uploaded into a project or opened at excalidraw.com; null when the key
 * holds no canvas. */
export function legacyCanvasAsExcalidraw(storage: Storage | null, key: string): { filename: string; text: string } | null {
  const document = readLegacyDocument(storage, key);
  if (!document) return null;
  const scene = normalizeExcalidrawScene(document.scene);
  return { filename: fitSegment(canvasFileStem(document.name), '.excalidraw'), text: JSON.stringify(scene, null, 2) };
}

/** A canvas a Nebula 1.x tab saved after the move (or one never moved),
 * to offer: `projectId` is where its earlier version went, if it did. */
export type OlderTabCanvas = { key: string; name: string; updatedAt: string; projectId: string | null };

/** Older-tab canvases already imported or put away (round 4, F8): a JSON
 * object of each localStorage key and the `updatedAt` it had then. */
export const OLDER_TAB_HANDLED_KEY = 'nebula:older-tab:handled';

type Handled = Record<string, string>;

function readHandled(storage: Storage | null): Handled {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(OLDER_TAB_HANDLED_KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    // Blocked, or damaged: offer everything, as before.
    return {};
  }
}

/** True when `later` is a newer save than `earlier` (ISO times; as text
 * when one doesn't parse). */
function savedAfter(later: string, earlier: string): boolean {
  const a = Date.parse(later);
  const b = Date.parse(earlier);
  return Number.isNaN(a) || Number.isNaN(b) ? later > earlier : a > b;
}

/** Records canvases the user imported or put away, as saved now, so the
 * offer leaves them out until an older tab saves them again. Best effort: a
 * full or blocked localStorage just means they're offered again. */
export function recordOlderTabHandled(storage: Storage | null, canvases: ReadonlyArray<Pick<OlderTabCanvas, 'key' | 'updatedAt'>>): void {
  if (!storage || canvases.length === 0) return;
  const handled = readHandled(storage);
  for (const canvas of canvases) handled[canvas.key] = canvas.updatedAt;
  try {
    storage.setItem(OLDER_TAB_HANDLED_KEY, JSON.stringify(handled));
  } catch {
    // Full or blocked.
  }
}

/** The canvases still in localStorage that aren't in a project as saved
 * (newerLegacyCanvases), for the offer, less those imported or put away
 * since their last save. */
export async function findOlderTabCanvases(storage: Storage | null, registry: BrowserRegistry): Promise<OlderTabCanvas[]> {
  // Where 1.x never ran there is nothing to find, and the migration's code
  // stays out of the visit (e2e/app-budget.spec.ts).
  if (!hasLegacyCanvases(storage)) return [];
  const { newerLegacyCanvases } = await import('../files/migration');
  const updates = await newerLegacyCanvases({ storage, registry });
  const handled = readHandled(storage);
  return updates
    .filter((update) => !(update.key in handled) || savedAfter(update.updatedAt, handled[update.key]))
    .map((update) => ({ key: update.key, name: update.name, updatedAt: update.updatedAt, projectId: update.migrated?.projectId ?? null }));
}

/** '<stem> (older tab)[ n].excalidraw.md', free among `taken` and at most
 * 255 bytes: the stem is shortened, never the rest. */
function olderTabName(name: string, taken: string[]): string {
  const base = canvasFileStem(name);
  for (let n = 1; ; n += 1) {
    const candidate = fitSegment(base, ` (older tab)${n > 1 ? ` ${n}` : ''}.excalidraw.md`);
    // uniqueName gives back a free name as it is.
    if (uniqueName(taken, candidate) === candidate) return candidate;
  }
}

/** Writes a 1.x canvas into a project as a new file at its root, never over
 * anything: '<name> (older tab).excalidraw.md', free and fitted to 255
 * bytes, written as the migration writes (compressed), and recorded as
 * handled. Returns its path. */
export async function importOlderTabCopy(input: { storage: Storage | null; registry: BrowserRegistry; key: string; projectId: string }): Promise<string> {
  const document = readLegacyDocument(input.storage, input.key);
  if (!document) throw new Error('That canvas is no longer in this browser.');
  const [{ toObsidianExcalidrawMarkdown }, store] = await Promise.all([import('../nebula/excalidraw/obsidianMarkdown'), input.registry.files(input.projectId)]);
  const taken = (await store.list()).filter((entry) => !entry.path.includes('/')).map((entry) => entry.name);
  const path = olderTabName(document.name, taken);
  await store.write(path, toObsidianExcalidrawMarkdown(normalizeExcalidrawScene(document.scene), { compressed: true }));
  recordOlderTabHandled(input.storage, [{ key: input.key, updatedAt: document.updatedAt }]);
  return path;
}
