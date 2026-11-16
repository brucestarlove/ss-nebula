import { useEffect, useState, useSyncExternalStore } from 'react';
import type { FileStore } from '../../../files/types';
import type { SessionScope } from './fileSessions';
import { createTextSession, type TextSession, type TextSessionState } from './textSession';

const LOADING: TextSessionState = {
  status: 'loading',
  text: '',
  dirty: false,
  conflict: false,
  removed: false,
  unreachable: null,
  moving: false,
  readOnly: false,
  revision: 0,
};

const subscribeToNothing = () => () => undefined;

/** Saves when the page is hidden or closed: a phone switching apps, a tab
 * being closed. Unmounting (leaving the tab) is the caller's dispose(). */
export function useLeaveFlush(flush: (() => Promise<void> | void) | undefined): void {
  useEffect(() => {
    if (!flush) return undefined;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    const onPageHide = () => void flush();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [flush]);
}

/** One TextSession per open file, flushed when leaving. `scope` is the
 * project's id (see fileSessions.ts). */
export function useTextSession(store: FileStore, path: string, scope?: SessionScope): { session: TextSession | null; state: TextSessionState } {
  const [session, setSession] = useState<TextSession | null>(null);

  useEffect(() => {
    const next = createTextSession(store, path, { scope });
    setSession(next);
    return () => {
      void next.dispose();
    };
  }, [store, path, scope]);

  const state = useSyncExternalStore(
    session ? session.subscribe : subscribeToNothing,
    () => session?.getState() ?? LOADING,
  );
  useLeaveFlush(session?.flush);

  return { session, state };
}
