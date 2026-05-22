export { mountNebula } from './mountNebula';
export type {
  MountNebulaOptions,
  NebulaMountContextInput,
  NebulaMountHandle,
  NebulaMountLifecycle,
  NebulaMountStatus,
} from './mountNebula';

export { LazyNebulaExcalidrawShell } from './LazyNebulaExcalidrawShell';
export type { LazyNebulaExcalidrawShellProps } from './LazyNebulaExcalidrawShell';
export type { NebulaExcalidrawShellProps } from './NebulaExcalidrawShell';

export {
  DEFAULT_NEBULA_BOARD_ID,
  DEFAULT_NEBULA_CANVAS_ID,
  nebulaContextFromSearchParams,
  resolveNebulaContext,
} from './context';
export type { NebulaContext, NebulaContextInput, NebulaHostContext, NebulaUserContext } from './context';

export { getNebulaOrbitContext } from './orbitContext';

export {
  LocalStorageSceneStore,
  createLocalStorageSceneStore,
} from './storage/localStorageSceneStore';
export {
  NEBULA_EXCALIDRAW_DOCUMENT_TYPE,
  NEBULA_EXCALIDRAW_DOCUMENT_VERSION,
  isNebulaExcalidrawDocument,
} from './storage/types';
export type {
  CanvasSummary,
  NebulaExcalidrawDocument,
  SceneStore,
  SceneStoreRef,
} from './storage/types';

export {
  createEmptyNebulaExcalidrawDocument,
} from './excalidraw/document';
export {
  createEmptyExcalidrawScene,
  isExcalidrawScene,
  normalizeExcalidrawScene,
} from './excalidraw/scene';
export type {
  ExcalidrawAppStateLike,
  ExcalidrawElementLike,
  ExcalidrawFilesLike,
  ExcalidrawScene,
} from './excalidraw/scene';

export type {
  NebulaArrowElement,
  NebulaArrowHead,
  NebulaArrowStyle,
  NebulaCanvas,
  NebulaCustomElement,
  NebulaCustomElementKind,
  NebulaDocument,
  NebulaDocumentMetadata,
  NebulaDocumentVersion,
  NebulaElement,
  NebulaElementBase,
  NebulaElementType,
  NebulaEllipseElement,
  NebulaImageElement,
  NebulaKnownCustomElementKind,
  NebulaLineElement,
  NebulaPoint,
  NebulaRectangleElement,
  NebulaSchema,
  NebulaStyle,
  NebulaTextElement,
  NebulaTextStyle,
  NebulaViewport,
} from './types';
