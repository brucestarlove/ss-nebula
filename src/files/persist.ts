/**
 * Persistent storage for the browser tier (PLAN §7): ask the browser not to
 * clear Nebula's files under storage pressure, and read how much they take,
 * for the status line. Browsers without the Storage API get null answers,
 * never errors. Chrome decides on its own; Firefox may ask the user, so call
 * requestPersistentStorage() when there is something worth keeping (after the
 * first project exists), not on every load.
 */

export type StorageStatus = {
  /** Whether the browser has promised to keep this site's storage; null when it can't say. */
  persisted: boolean | null;
  /** Bytes this origin uses, when the browser says. */
  usage?: number;
  /** Bytes this origin may use, when the browser says. */
  quota?: number;
};

function defaultStorage(): StorageManager | undefined {
  return typeof navigator !== 'undefined' ? navigator.storage : undefined;
}

async function isPersisted(storage: StorageManager | undefined): Promise<boolean | null> {
  if (typeof storage?.persisted !== 'function') return null;
  try {
    return await storage.persisted();
  } catch {
    return null;
  }
}

/** Asks for persistent storage unless it is already granted. true or false:
 * the browser's answer; null: this browser has no way to ask. */
export async function requestPersistentStorage(storage: StorageManager | undefined = defaultStorage()): Promise<boolean | null> {
  if (typeof storage?.persist !== 'function') return null;
  if ((await isPersisted(storage)) === true) return true;
  try {
    return await storage.persist();
  } catch {
    return false;
  }
}

/** Whether storage is persistent, and the usage estimate, as far as the browser says. */
export async function storageStatus(storage: StorageManager | undefined = defaultStorage()): Promise<StorageStatus> {
  const status: StorageStatus = { persisted: await isPersisted(storage) };
  if (typeof storage?.estimate !== 'function') return status;
  try {
    const { usage, quota } = await storage.estimate();
    if (typeof usage === 'number') status.usage = usage;
    if (typeof quota === 'number') status.quota = quota;
  } catch {
    // No estimate: the status line leaves the size out.
  }
  return status;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** '1.2 MB': decimal units, as macOS and the sketch's status line show them;
 * one decimal below ten, none above. */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${UNITS[unit]}`;
}
