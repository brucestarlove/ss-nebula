/** When each project was last downloaded as a .zip from this browser: the one
 * copy outside the browser that Nebula knows of, so Settings can say how old
 * it is. Kept in this browser's localStorage under 'nebula:downloads' as
 * { [projectId]: milliseconds since the epoch }. */

const KEY = 'nebula:downloads';

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;

function localStorageOrNull(): KeyValue | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readAll(storage: KeyValue | null): Record<string, number> {
  if (!storage) return {};
  try {
    const value: unknown = JSON.parse(storage.getItem(KEY) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])),
    );
  } catch {
    return {};
  }
}

export function lastDownloaded(id: string, storage: KeyValue | null = localStorageOrNull()): number | null {
  const all = readAll(storage);
  return Object.hasOwn(all, id) ? all[id]! : null;
}

export function recordDownload(id: string, at = Date.now(), storage: KeyValue | null = localStorageOrNull()): void {
  if (!storage) return;
  try {
    storage.setItem(KEY, JSON.stringify({ ...readAll(storage), [id]: at }));
  } catch {
    // Storage full or blocked: Settings keeps saying what it said.
  }
}

/** 'Last downloaded today.', by the calendar where the person is. */
export function downloadedLabel(at: number | null, now = Date.now()): string {
  if (at === null) return 'Not downloaded yet.';
  const days = calendarDays(at, now);
  if (days <= 0) return 'Last downloaded today.';
  if (days === 1) return 'Last downloaded yesterday.';
  return `Last downloaded ${days} days ago.`;
}

function calendarDays(from: number, to: number): number {
  const a = new Date(from);
  const b = new Date(to);
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000);
}
