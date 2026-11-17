import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import type { ExcalidrawProps } from '@excalidraw/excalidraw/types';
import type { NebulaContextInput } from './context';
import type { SceneStore } from './storage/types';

const NebulaExcalidrawShell = lazy(() =>
  import('./NebulaExcalidrawShell').then((module) => ({
    default: module.NebulaExcalidrawShell,
  })),
);

export type LazyNebulaExcalidrawShellProps = {
  context?: NebulaContextInput;
  store?: SceneStore;
  fallback?: ReactNode;
  onReady?: () => void;
  /** `false` renders the canvas alone, without Nebula's chrome; see
   * NebulaExcalidrawShellProps.chrome. Defaults to `true`. */
  chrome?: boolean;
  /** See NebulaExcalidrawShellProps.onLinkOpen. */
  onLinkOpen?: ExcalidrawProps['onLinkOpen'];
  /** See NebulaExcalidrawShellProps.linksFromText. */
  linksFromText?: boolean;
};

export function LazyNebulaExcalidrawShell(props: LazyNebulaExcalidrawShellProps) {
  return (
    <Suspense
      fallback={
        props.fallback ?? (
          <div className="nebula-loading" role="status" aria-live="polite">
            <span className="nebula-loading__title">Opening Nebula canvas…</span>
            <span className="nebula-loading__hint">Local-first scene data stays in this browser.</span>
          </div>
        )
      }
    >
      <NebulaExcalidrawShell {...props} />
    </Suspense>
  );
}
