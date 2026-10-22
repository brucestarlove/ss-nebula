import type { FileEntry, WorkspaceState } from '../files/types';
import { dirname, isInside } from '../files/paths';
import { movePath } from './paths';

/** What a project had open (`.nebula/workspace.json`), restored when you
 * come back to it. The workspace keeps one per project and saves it through
 * the project's own FileStore, so it travels with the folder. */
export const EMPTY_WORKSPACE: WorkspaceState = { tabs: [], active: null, expanded: [], starred: [] };

export const WORKSPACE_FILE = '.nebula/workspace.json';

export type WorkspaceAction =
  | { type: 'load'; state: WorkspaceState }
  | { type: 'open'; path: string }
  | { type: 'activate'; path: string }
  | { type: 'close'; path: string }
  | { type: 'moveTab'; path: string; to: number }
  | { type: 'toggleExpanded'; path: string }
  | { type: 'setExpanded'; path: string; expanded: boolean }
  | { type: 'reveal'; path: string }
  | { type: 'toggleStar'; path: string }
  | { type: 'renamed'; from: string; to: string }
  /** `keep`: a tab to leave open (the file on screen, deleted elsewhere). */
  | { type: 'removed'; path: string; keep?: string }
  | { type: 'prune'; entries: FileEntry[] };

/** After tabs close, the focus goes to the next tab that's left, or else the
 * previous one, as browsers do. */
function nextActive(before: string[], after: string[], active: string | null): string | null {
  if (active !== null && after.includes(active)) return active;
  if (after.length === 0) return null;
  const index = active === null ? -1 : before.indexOf(active);
  if (index === -1) return after[0];
  const kept = new Set(after);
  for (let i = index + 1; i < before.length; i += 1) if (kept.has(before[i])) return before[i];
  for (let i = index - 1; i >= 0; i -= 1) if (kept.has(before[i])) return before[i];
  return after[0];
}

function withTabs(state: WorkspaceState, tabs: string[]): WorkspaceState {
  return { ...state, tabs, active: nextActive(state.tabs, tabs, state.active) };
}

function ancestors(path: string): string[] {
  const folders: string[] = [];
  for (let folder = dirname(path); folder; folder = dirname(folder)) folders.unshift(folder);
  return folders;
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'load':
      return action.state;
    case 'open':
      return {
        ...state,
        tabs: state.tabs.includes(action.path) ? state.tabs : [...state.tabs, action.path],
        active: action.path,
      };
    case 'activate':
      return state.tabs.includes(action.path) ? { ...state, active: action.path } : state;
    case 'close':
      return withTabs(state, state.tabs.filter((tab) => tab !== action.path));
    case 'moveTab': {
      if (!state.tabs.includes(action.path)) return state;
      const tabs = state.tabs.filter((tab) => tab !== action.path);
      const to = Math.max(0, Math.min(action.to, tabs.length));
      tabs.splice(to, 0, action.path);
      return { ...state, tabs };
    }
    case 'toggleExpanded':
      return {
        ...state,
        expanded: state.expanded.includes(action.path)
          ? state.expanded.filter((path) => path !== action.path)
          : [...state.expanded, action.path],
      };
    case 'setExpanded': {
      const has = state.expanded.includes(action.path);
      if (has === action.expanded) return state;
      return {
        ...state,
        expanded: action.expanded ? [...state.expanded, action.path] : state.expanded.filter((path) => path !== action.path),
      };
    }
    case 'reveal': {
      const missing = ancestors(action.path).filter((folder) => !state.expanded.includes(folder));
      return missing.length ? { ...state, expanded: [...state.expanded, ...missing] } : state;
    }
    case 'toggleStar':
      return {
        ...state,
        starred: state.starred.includes(action.path)
          ? state.starred.filter((path) => path !== action.path)
          : [...state.starred, action.path],
      };
    case 'renamed': {
      const move = (path: string) => movePath(path, action.from, action.to);
      return {
        tabs: unique(state.tabs.map(move)),
        active: state.active === null ? null : move(state.active),
        expanded: unique(state.expanded.map(move)),
        starred: unique(state.starred.map(move)),
      };
    }
    case 'removed': {
      const keep = (path: string) => !isInside(path, action.path);
      return {
        ...withTabs(state, state.tabs.filter((path) => keep(path) || path === action.keep)),
        expanded: state.expanded.filter(keep),
        starred: state.starred.filter(keep),
      };
    }
    case 'prune': {
      const files = new Set<string>();
      const folders = new Set<string>();
      for (const entry of action.entries) (entry.type === 'dir' ? folders : files).add(entry.path);
      return {
        ...withTabs(state, state.tabs.filter((path) => files.has(path))),
        expanded: state.expanded.filter((path) => folders.has(path)),
        starred: state.starred.filter((path) => files.has(path) || folders.has(path)),
      };
    }
  }
}

function paths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return unique(value.filter((item): item is string => typeof item === 'string' && item.length > 0));
}

/** workspace.json, read defensively: broken JSON or a wrong shape starts
 * empty, and a damaged file keeps whatever parts still make sense. */
export function parseWorkspaceState(text: string | null): WorkspaceState {
  if (!text) return EMPTY_WORKSPACE;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return EMPTY_WORKSPACE;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return EMPTY_WORKSPACE;
  const record = data as Record<string, unknown>;
  const tabs = paths(record.tabs);
  const active = typeof record.active === 'string' && tabs.includes(record.active) ? record.active : (tabs[0] ?? null);
  return { tabs, active, expanded: paths(record.expanded), starred: paths(record.starred) };
}

export function serializeWorkspaceState(state: WorkspaceState): string {
  const { tabs, active, expanded, starred } = state;
  return `${JSON.stringify({ tabs, active, expanded, starred }, null, 2)}\n`;
}
