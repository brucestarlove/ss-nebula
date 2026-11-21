/**
 * The storage layer's public surface. The workspace
 * and the app import from here.
 *
 * First run, in order:
 *
 *   const { registry, persistent, reason } = await openBrowserRegistry();
 *   let id = await registry.current();
 *   if (!id) id = (await seedSampleProject(registry)).project.id;  // brand-new visitors only
 *   const store = await registry.open(id);
 *
 * `persistent: false` means nothing will be kept: say so, and offer Download
 * (projectToZip). The sample is worth loading lazily
 * (`await import('./sample')`): it carries text.
 */
export type {
  EntryType,
  FileChange,
  FileEntry,
  FileKind,
  FileStore,
  FileViewProps,
  FolderAccess,
  FolderHandle,
  NewProject,
  Preferences,
  ProjectMeta,
  ProjectRecord,
  ProjectRegistry,
  ProjectTier,
  WorkspaceState,
} from './types';
export { DEFAULT_PREFERENCES } from './types';
export { DEFAULT_PLANET_COLOUR, PLANET_COLOURS } from './palette';
export { kindFromContent, kindFromName, kindOf } from './kinds';
export {
  InvalidPathError,
  ancestors,
  basename,
  comparePaths,
  dirname,
  extension,
  isInside,
  isValidPath,
  joinPath,
  newNameProblem,
  normalizePath,
  portableName,
  stem,
  uniqueName,
} from './paths';
export { EntryTypeError, FileExistsError, FileNotFoundError, errorName } from './errors';
export { blobToBytes, blobToText } from './bytes';
export { MemoryFileStore, type MemoryFileStoreOptions } from './memoryStore';
export { OpfsFileStore, type OpfsFileStoreOptions } from './opfsStore';
export { PathLocks } from './pathLocks';
export { webLocks, withLock, type LockManagerLike } from './locks';
export { scopedStore } from './scopedStore';
export { FOLDER_DB, MemoryFolderHandles, indexedDbFolderHandles, type FolderHandleStore } from './folderHandles';
export { FolderFileStore, folderFileStore } from './folderStore';
export { FolderUnavailableError, folderAccess, folderExists, requestFolderAccess, type FolderTier } from './folderTier';
export {
  InvalidProjectError,
  NoFolderTierError,
  ReadOnlyRegistryError,
  createBrowserRegistry,
  isValidProjectId,
  newProjectId,
  type BrowserRegistry,
  type BrowserRegistryOptions,
  type CreateProjectInput,
} from './registry';
export { OPFS_TREE, createOpfsRegistry, openBrowserRegistry, probeOpfs, type BrowserRegistryHandle, type OpfsProbe } from './opfsRegistry';
export { DEFAULT_WORKSPACE_STATE, emptyWorkspaceState, readWorkspaceState, writeWorkspaceState } from './workspaceState';
export { SAMPLE_PROJECT, seedSampleProject, type SampleOptions, type SampleResult } from './sample';
export { projectToZip, zipFileName, type ZipOptions } from './zip';
export { formatBytes, onPersistenceAnswer, requestPersistentStorage, storageStatus, type StorageStatus } from './persist';
