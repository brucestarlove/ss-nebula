import { formatBytes } from '../files/persist';
import type { FileEntry } from '../files/types';

// Sizes are src/files/persist.ts's formatBytes: decimal units, one decimal
// below 10, as file managers say them.
export { formatBytes };

export function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
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
