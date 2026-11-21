import { formatBytes } from '../files/persist';
import type { FileEntry } from '../files/types';

// Sizes are src/files/persist.ts's formatBytes: decimal units, one decimal
// below 10, as file managers say them.
export { formatBytes };

/** '1 file', '2 files'; a noun that doesn't take a plain s gives its plural ('canvas', 'canvases'). */
export function countLabel(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}

/** '14 files · 2.1 MB' */
export function usageLabel(entries: FileEntry[]): string {
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (entry.type !== 'file') continue;
    files += 1;
    bytes += entry.size ?? 0;
  }
  return `${countLabel(files, 'file')} · ${formatBytes(bytes)}`;
}
