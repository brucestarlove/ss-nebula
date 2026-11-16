import { basename } from '../files/paths';
import { describeName } from './paths';
import type { KeptCopy } from './views/shared/fileSessions';

/**
 * The line the workspace shows for a change kept from a conflict (re-review
 * R1, round 4 F2 and F5): where the copy went, or that it couldn't be written
 * and why (or, round 6 H3, that the change's own save failed as it closed), in plain words where the cause is known. This is the moment a
 * person worries about their work, so a browser's raw error isn't the
 * message unless nothing better is known.
 */
export function keptCopyText(kept: KeptCopy): string {
  const label = (path: string) => describeName(basename(path)).label;
  const name = label(kept.path);
  if (kept.copy !== null) {
    return kept.deleted
      ? `${name} was deleted in another tab. Your changes were kept as ‘${label(kept.copy)}’.`
      : `Your changes to ${name} were kept as ‘${label(kept.copy)}’.`;
  }
  const why = plainReason(kept.error);
  // No conflict: the change's own save failed as its view closed.
  const failed = kept.failedSave ? `Couldn’t save your changes to ${name}` : `Couldn’t keep your changes to ${name} as a copy`;
  return why ? `${failed}: ${why}. Download them so they aren’t lost.` : `${failed} (${rawReason(kept.error)}). Download them so they aren’t lost.`;
}

function plainReason(error: unknown): string | null {
  const name = (error as { name?: unknown } | null)?.name;
  const message = rawReason(error);
  if (name === 'QuotaExceededError' || /quota/i.test(message)) return 'this browser’s storage is full';
  if (name === 'InvalidPathError' && /longer than/.test(message)) return 'its name is too long';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'this browser won’t let Nebula save here';
  return null;
}

function rawReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[.!]+$/, '');
}
