import type { NebulaContextInput } from './context';
import { resolveNebulaContext } from './context';

export type { NebulaContext, NebulaContextInput, NebulaUserContext } from './context';

/**
 * Backward-compatible name for the pre-Excalidraw Orbit context seam.
 */
export type NebulaOrbitContext = NebulaContextInput;

export function getNebulaOrbitContext() {
  return resolveNebulaContext();
}
