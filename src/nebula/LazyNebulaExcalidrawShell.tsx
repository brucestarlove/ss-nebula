import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import type { ExcalidrawProps } from '@excalidraw/excalidraw/types';
import type { NebulaContext } from './context';
import type { SceneStore } from './storage/types';

const NebulaExcalidrawShell = lazy(() =>
  import('./NebulaExcalidrawShell').then((module) => ({
    default: module.NebulaExcalidrawShell,
  })),
);

export type LazyNebulaExcalidrawShellProps = {
  context: NebulaContext;
  store: SceneStore;
  /** Shown while the canvas's chunk loads: the canvas view gives its own. */
  fallback: ReactNode;
  /** See NebulaExcalidrawShellProps.onLinkOpen. */
  onLinkOpen?: ExcalidrawProps['onLinkOpen'];
  /** See NebulaExcalidrawShellProps.linksFromText. */
  linksFromText?: boolean;
  /** See NebulaExcalidrawShellProps.generateIdForFile. */
  generateIdForFile?: ExcalidrawProps['generateIdForFile'];
};

export function LazyNebulaExcalidrawShell(props: LazyNebulaExcalidrawShellProps) {
  return (
    <Suspense fallback={props.fallback}>
      <NebulaExcalidrawShell {...props} />
    </Suspense>
  );
}
