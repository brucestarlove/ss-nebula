import { useEffect, useState } from 'react';
import { spaceOf } from '../files/account';
import type { SpaceInfo } from '../files/serverContract';

/** The account's space as the server's place says it, asked afresh each time Settings opens, for a
 * store that has an account (a server project). Null where the place sends none, and until it has. */
export function useSpace(store: unknown, open: boolean): SpaceInfo | null {
  const [space, setSpace] = useState<SpaceInfo | null>(null);
  useEffect(() => {
    setSpace(null);
  }, [store]);
  useEffect(() => {
    const source = open ? spaceOf(store) : null;
    if (!source) return undefined;
    let cancelled = false;
    source.space().then(
      (found) => {
        if (!cancelled) setSpace(found ?? null);
      },
      () => {
        // Not asked or not answered: Settings shows no space rather than a stale number.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [store, open]);
  return space;
}
