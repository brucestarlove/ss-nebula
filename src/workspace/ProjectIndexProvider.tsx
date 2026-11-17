import { useSyncExternalStore, type ReactNode } from 'react';
import { ProjectIndexContext } from './projectIndex';
import type { ProjectIndexSource } from './useProjectIndexBuild';

/** Provides the project index from its source (useProjectIndexBuild.ts):
 * only this and what reads the index draw again as it grows. */
export function ProjectIndexProvider({ source, children }: { source: ProjectIndexSource; children: ReactNode }) {
  const index = useSyncExternalStore(source.subscribe, source.current);
  return <ProjectIndexContext.Provider value={index}>{children}</ProjectIndexContext.Provider>;
}
