import { isValidPath } from './paths';
import type { FileStore, WorkspaceState } from './types';

const WORKSPACE = '.nebula/workspace.json';

/** Nothing open. Frozen: use emptyWorkspaceState() for a copy to change. */
export const DEFAULT_WORKSPACE_STATE: WorkspaceState = Object.freeze({
  tabs: Object.freeze([]),
  active: null,
  expanded: Object.freeze([]),
  starred: Object.freeze([]),
}) as unknown as WorkspaceState;

export function emptyWorkspaceState(): WorkspaceState {
  return { tabs: [], active: null, expanded: [], starred: [] };
}

function paths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && isValidPath(item)))];
}

/** What was open in this project. Safe defaults when the file is missing or
 * damaged, keeping whatever parts of it are still valid. */
export async function readWorkspaceState(store: FileStore): Promise<WorkspaceState> {
  let raw: unknown;
  try {
    raw = JSON.parse(await store.readText(WORKSPACE));
  } catch {
    return emptyWorkspaceState();
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return emptyWorkspaceState();
  const state = raw as Record<string, unknown>;
  const tabs = paths(state.tabs);
  return {
    tabs,
    active: typeof state.active === 'string' && tabs.includes(state.active) ? state.active : null,
    expanded: paths(state.expanded),
    starred: paths(state.starred),
  };
}

export async function writeWorkspaceState(store: FileStore, state: WorkspaceState): Promise<void> {
  const clean: WorkspaceState = { tabs: [...state.tabs], active: state.active, expanded: [...state.expanded], starred: [...state.starred] };
  await store.write(WORKSPACE, `${JSON.stringify(clean, null, 2)}\n`);
}
