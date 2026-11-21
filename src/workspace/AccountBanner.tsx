import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { signInAgain } from '../app/frameBridge';
import { accountOf, contextOf, watchAccount } from '../files/account';
import { Button } from './components/Button';

/** Says once, for every open file, that the session has ended; gone when it's back. The edits are
 * kept where they were made (each file's own bar says so too), and saved once the session is back. */
export function AccountBanner({ store }: { store: unknown }) {
  const [signedOut, setSignedOut] = useState<{ signIn?: string } | null>(() => accountOf(store)?.signedOut() ?? null);
  useEffect(() => {
    const account = accountOf(store);
    setSignedOut(account?.signedOut() ?? null);
    return watchAccount(store, () => setSignedOut(account?.signedOut() ?? null));
  }, [store]);
  if (!signedOut) return null;
  return (
    <div className="ws-ephemeral ws-account-banner" role="alert">
      <span className="ws-store-dot" data-attention="" aria-hidden="true" />
      <p>You’re signed out. Your changes are kept here until you sign in again.</p>
      <Button className="ws-btn" onClick={() => signInAgain(signedOut.signIn)}>
        Sign in again
      </Button>
    </div>
  );
}

const never = () => () => {};

/** A quiet mark where a file is open from an Orbit card: the link its changes then name. Never a
 * banner, and kept nowhere on this device (the store holds it for this tab). */
export function ContextMark({ store, path }: { store: unknown; path: string | null }) {
  const source = contextOf(store);
  const subscribe = useCallback((listener: () => void) => source?.onContext(listener) ?? never(), [source]);
  const context = useSyncExternalStore(subscribe, () => (source && path ? source.contextOf(path) : undefined));
  if (!context) return null;
  return (
    <p className="ws-context-mark" title={context}>
      {context.startsWith('orbit:card/') ? 'From an Orbit card' : 'Opened from a link'}
    </p>
  );
}
