import { useEffect, useRef } from 'react';
import { signInAgain, safeLink } from '../../../app/frameBridge';
import { watchAccount } from '../../../files/account';
import { accountError, keptWords } from './accountErrors';
import { errorMessage } from './download';

/**
 * What a save bar says and offers when a save failed: the words, and the way out. A session that
 * ended or a space that's full say so and that the edit is kept, and offer "Sign in again" or
 * "Get more space"; every failure offers Try again.
 *
 * `store`, when the view's own session doesn't resume by itself (the canvas), saves again once the
 * session is back, so the person who signs in elsewhere isn't left pressing a button.
 */
export function SaveFailure({ error, onTryAgain, store }: { error: unknown; onTryAgain: () => void; store?: unknown }) {
  const account = accountError(error);
  const again = useRef(onTryAgain);
  again.current = onTryAgain;
  const signedOut = account?.kind === 'signed-out';
  useEffect(() => {
    if (!store || !signedOut) return undefined;
    return watchAccount(store, (status) => {
      if (status === 'signed-in') again.current();
    });
  }, [store, signedOut]);
  const upgrade = account?.kind === 'space-full' ? safeLink(account.upgrade) : null;
  return (
    <>
      <span className="ws-conflict-text">{account ? keptWords(account) : `Couldn’t save. ${errorMessage(error)}`}</span>
      {account?.kind === 'signed-out' ? (
        <button type="button" className="ws-view-btn" data-no-arc onClick={() => signInAgain(account.signIn)}>
          Sign in again
        </button>
      ) : null}
      {upgrade ? (
        <a className="ws-view-btn" href={upgrade} target="_blank" rel="noopener noreferrer">
          Get more space
        </a>
      ) : null}
      <button type="button" className="ws-view-btn" data-no-arc onClick={onTryAgain}>
        Try again
      </button>
    </>
  );
}
