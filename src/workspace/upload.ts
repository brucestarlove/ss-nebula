import { extension, joinPath, newNameProblem, normalizePath, portableName, stem, uniqueName } from '../files/paths';
import type { FileStore } from '../files/types';
import { validateName } from './paths';

// What a kept name can't hold, each swapped for '_': path separators,
// control characters, the characters Windows refuses (so a download still
// unpacks there), and the ones that make a name read as something else
// (bidi controls, line and paragraph separators).
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069]/g;
const MAX_BYTES = 255;
const utf8 = new TextEncoder();

function bytes(text: string): number {
  return utf8.encode(text).length;
}

/** The name, shortened to 255 bytes of UTF-8, keeping its extension. */
function fit(name: string): string {
  if (bytes(name) <= MAX_BYTES) return name;
  const ext = extension(name);
  const suffix = ext ? `.${ext}` : '';
  const kept = Array.from(suffix && bytes(suffix) < MAX_BYTES / 2 ? stem(name) : name);
  const end = kept.length === Array.from(name).length ? '' : suffix;
  while (kept.length > 0 && bytes(kept.join('') + end) > MAX_BYTES) kept.pop();
  return kept.join('') + end;
}

function errorText(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : String(reason);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** A name from the user's computer, made safe to keep, or why it can't be
 * (review finding 17). */
export function uploadName(name: string): { name: string } | { problem: string } {
  const cleaned = fit(name.replace(UNSAFE, '_').trim());
  // Windows' rules are mapped, so the file still goes in: a reserved device
  // name gets '_', a trailing dot or space goes. A name nothing can have
  // ('', '.', '..', '.nebula') is refused, as before.
  const safe = newNameProblem(cleaned) && /[^. ]/.test(cleaned) ? portableName(cleaned) : cleaned;
  const problem = validateName(safe);
  if (problem) return { problem };
  try {
    normalizePath(safe);
  } catch (reason) {
    return { problem: errorText(reason) };
  }
  return { name: safe };
}

export type UploadResult = {
  /** Paths written, in order. */
  added: string[];
  /** One line per file that wasn't added: its name and why. */
  skipped: string[];
};

/** Adds files to a folder, each under a safe, free name; a file that can't
 * be added is skipped with a message and the rest still go in. `taken` is
 * the names already in the folder. */
export async function addFiles(store: FileStore, folder: string, files: File[], taken: string[]): Promise<UploadResult> {
  const result: UploadResult = { added: [], skipped: [] };
  const names = [...taken];
  for (const file of files) {
    const safe = uploadName(file.name);
    if ('problem' in safe) {
      result.skipped.push(`“${file.name.replace(UNSAFE, '_')}”: ${safe.problem}`);
      continue;
    }
    try {
      const name = uniqueName(names, safe.name);
      const path = joinPath(folder, name);
      await store.write(path, file);
      names.push(name);
      result.added.push(path);
    } catch (reason) {
      result.skipped.push(`“${safe.name}”: ${errorText(reason)}`);
    }
  }
  return result;
}
