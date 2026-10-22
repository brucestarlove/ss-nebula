import type { FileEntry, FileStore } from '../../../files/types';
import { OPAQUE_TYPE, typedBlob } from './mime';

// Long enough for any browser to start the download from the URL.
const REVOKE_AFTER_MS = 60_000;

/** Saves the file to the device. The bytes go out as opaque data, so even a
 * "page.html" can't open as a page of this origin. */
export async function downloadEntry(store: FileStore, entry: Pick<FileEntry, 'path' | 'name'>): Promise<void> {
  const blob = typedBlob(await store.readBlob(entry.path), entry.name, OPAQUE_TYPE);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = entry.name;
  anchor.rel = 'noopener';
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Unknown error';
}
