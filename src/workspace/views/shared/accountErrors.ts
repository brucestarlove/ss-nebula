import { errorName } from '../../../files/errors';
import { formatBytes } from './format';

/**
 * The two errors that are about the person, not the file (`SignedOutError` and `SpaceFullError`,
 * src/files/serverStore.ts), found by name as every other store error is, so the views don't
 * load the server tier. The words say what's true: a failed save keeps the edit where it was made.
 */
export type AccountError =
  | { kind: 'signed-out'; signIn?: string }
  | { kind: 'space-full'; used: number; limit: number; upgrade?: string };

export function accountError(error: unknown): AccountError | null {
  const name = errorName(error);
  const fields = error as { signIn?: unknown; used?: unknown; limit?: unknown; upgrade?: unknown };
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  if (name === 'SignedOutError') return { kind: 'signed-out', signIn: text(fields.signIn) };
  if (name === 'SpaceFullError') {
    return { kind: 'space-full', used: Number(fields.used) || 0, limit: Number(fields.limit) || 0, upgrade: text(fields.upgrade) };
  }
  return null;
}

/** "Your space is full (120 MB of 1 GB)." */
export function spaceFullMessage(error: Extract<AccountError, { kind: 'space-full' }>): string {
  return error.limit > 0 ? `Your space is full (${formatBytes(error.used)} of ${formatBytes(error.limit)}).` : 'Your space is full.';
}

/** The bar's line for a save that met one of them: why, and that the edit is safe. */
export function keptWords(error: AccountError): string {
  return error.kind === 'signed-out'
    ? 'You’re signed out. Your changes are kept here until you sign in again.'
    : `${spaceFullMessage(error)} Your changes are kept here until there’s room.`;
}
