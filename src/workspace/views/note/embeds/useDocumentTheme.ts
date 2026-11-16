import { useSyncExternalStore } from 'react';

export type DocumentTheme = 'light' | 'dark';

const DARK = '(prefers-color-scheme: dark)';

function read(): DocumentTheme {
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme === 'dark' || theme === 'light') return theme;
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK).matches ? 'dark' : 'light';
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const query = typeof window.matchMedia === 'function' ? window.matchMedia(DARK) : null;
  query?.addEventListener?.('change', onChange);
  return () => {
    observer.disconnect();
    query?.removeEventListener?.('change', onChange);
  };
}

/** The page's theme, as `<html data-theme>` says it (else the system's), kept current: what an embedded drawing is exported for. */
export function useDocumentTheme(): DocumentTheme {
  return useSyncExternalStore(subscribe, read, () => 'light');
}
