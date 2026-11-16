import type { RefObject } from 'react';
import type { ProjectRecord } from '../../files/types';
import { NEBULA_LOGO_SRC } from '../../nebula/ui/logo';
import { Button, Planet } from './Button';
import { FileTree, type FileTreeProps } from './FileTree';
import { Icon, type IconName } from './icons';
import { isContextMenuKey, menuAtElement, type MenuAt } from './ui';

export type StarredItem = { path: string; label: string; icon: IconName };

type RailProps = {
  project: ProjectRecord | null;
  oneProject: boolean;
  location: string;
  usage: string;
  ephemeral: boolean;
  /** The browser hasn't promised to keep the files: the status says they may be cleared. */
  attention: boolean;
  /** A folder project's folder: the status names it, on this computer. */
  folderName?: string | null;
  /** Why a folder project's folder can't be opened now ('Needs your OK'):
   * the status says it, amber, and nothing offers to make files. */
  blocked?: string | null;
  night: boolean;
  collapsed: boolean;
  menuOpen: boolean;
  contextOpen: boolean;
  switcherRef: RefObject<HTMLButtonElement | null>;
  starred: StarredItem[];
  activePath: string | null;
  tree: FileTreeProps;
  searchShortcut: string;
  collapseShortcut: string;
  onSwitcher: () => void;
  onSwitcherMenu: (at: MenuAt) => void;
  onRenameProject: () => void;
  onSearch: () => void;
  onNewNote: () => void;
  onNewCanvas: () => void;
  onNewFolder: () => void;
  onUpload: () => void;
  onOpenStarred: (path: string) => void;
  onStarredMenu: (path: string, at: MenuAt) => void;
  onToggleTheme: () => void;
  onSettings: () => void;
  /** Opens Settings at the project's files; absent without a project. */
  onWhere?: () => void;
  onHelp: () => void;
  onToggleCollapsed: () => void;
};

/** The left rail: ss-ui's sidebar template, extended for a file tree (the
 * project switcher in its header, actions on the section head, type marks,
 * a toolbelt when folded). */
export function Rail(props: RailProps) {
  const { project, oneProject, collapsed } = props;
  return (
    <aside className="page-sidebar ws-rail" aria-label="Project">
      <Button
        ref={props.switcherRef}
        className="page-sidebar-header ws-switcher"
        aria-haspopup="menu"
        aria-expanded={props.menuOpen}
        data-context-open={props.contextOpen ? '' : undefined}
        // Named by its text; folded, the text is hidden, so it needs a label.
        aria-label={collapsed ? (project?.name ?? 'Projects') : undefined}
        title={collapsed && project ? project.name : undefined}
        onClick={props.onSwitcher}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onSwitcherMenu({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (isContextMenuKey(event)) {
            event.preventDefault();
            props.onSwitcherMenu(menuAtElement(event.currentTarget));
          } else if (event.key === 'F2' && project) {
            event.preventDefault();
            props.onRenameProject();
          }
        }}
      >
        {oneProject ? (
          <img className="ws-switcher-logo" src={NEBULA_LOGO_SRC} alt="" width={32} height={28} />
        ) : project ? (
          <Planet color={project.color} className="page-sidebar-logo" />
        ) : null}
        <span className="page-sidebar-titles">
          <span className="page-sidebar-title">{project?.name ?? 'Nebula'}</span>
          <span className="page-sidebar-subtitle">{project ? props.location : 'No project open'}</span>
        </span>
        <Icon name="updown" className="ws-switcher-caret" />
      </Button>

      <div className="page-sidebar-search">
        <Button className="ws-search-field" onClick={props.onSearch} aria-keyshortcuts="Meta+K Control+K">
          <Icon name="search" />
          <span>Search or jump to…</span>
          <kbd aria-hidden="true">{props.searchShortcut}</kbd>
        </Button>
      </div>

      {collapsed ? (
        <div className="ws-toolbelt" role="group" aria-label="Quick actions">
          <Button className="ws-icon-btn" aria-label="Search" title={`Search (${props.searchShortcut})`} onClick={props.onSearch}>
            <Icon name="search" />
          </Button>
          <Button
            className="ws-icon-btn"
            aria-label="Show files"
            title={`Show files (${props.collapseShortcut})`}
            onClick={props.onToggleCollapsed}
          >
            <Icon name="files" />
          </Button>
          {props.blocked ? null : (
            <>
              <Button className="ws-icon-btn" aria-label="New note" title="New note" onClick={props.onNewNote}>
                <Icon name="note-plus" />
              </Button>
              <Button className="ws-icon-btn" aria-label="New canvas" title="New canvas" onClick={props.onNewCanvas}>
                <Icon name="canvas-plus" />
              </Button>
            </>
          )}
        </div>
      ) : null}

      <nav className="page-sidebar-nav ws-tree" aria-label="Files">
        {props.starred.length > 0 ? (
          <div className="page-sidebar-section ws-starred">
            <div className="page-sidebar-section-label" id="ws-starred-label">
              Starred
            </div>
            <ul aria-labelledby="ws-starred-label">
              {props.starred.map((item) => (
                <li key={item.path}>
                  <Button
                    className="page-sidebar-nav-item"
                    onClick={() => props.onOpenStarred(item.path)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      props.onStarredMenu(item.path, { x: event.clientX, y: event.clientY });
                    }}
                    onKeyDown={(event) => {
                      if (!isContextMenuKey(event)) return;
                      event.preventDefault();
                      props.onStarredMenu(item.path, menuAtElement(event.currentTarget));
                    }}
                  >
                    <span className="page-sidebar-nav-icon">
                      <Icon name={item.icon} />
                    </span>
                    <span className="page-sidebar-nav-label">{item.label}</span>
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="page-sidebar-section ws-files-section">
          <div className="ws-section-head">
            <div className="page-sidebar-section-label" aria-hidden="true">
              Files
            </div>
            {props.blocked ? null : (
              <div className="ws-section-actions">
                <Button className="ws-icon-btn" aria-label="New note" title="New note" onClick={props.onNewNote}>
                  <Icon name="note-plus" />
                </Button>
                <Button className="ws-icon-btn" aria-label="New canvas" title="New canvas" onClick={props.onNewCanvas}>
                  <Icon name="canvas-plus" />
                </Button>
                <Button className="ws-icon-btn" aria-label="New folder" title="New folder" onClick={props.onNewFolder}>
                  <Icon name="folder-plus" />
                </Button>
                <Button className="ws-icon-btn" aria-label="Upload files" title="Upload files" onClick={props.onUpload}>
                  <Icon name="upload" />
                </Button>
              </div>
            )}
          </div>
          <FileTree {...props.tree} />
        </div>
      </nav>

      <div className="page-sidebar-footer ws-rail-footer">
        <span
          className="ws-store-dot"
          data-ephemeral={props.ephemeral ? '' : undefined}
          data-attention={props.attention || props.blocked ? '' : undefined}
          aria-hidden="true"
        />
        {props.onWhere ? (
          <Button className="page-sidebar-footer-text ws-rail-where" title="Where your files are kept" onClick={props.onWhere}>
            <span className="page-sidebar-footer-name">{props.folderName ?? props.location}</span>
            <span className="page-sidebar-footer-meta">{props.blocked ?? (props.folderName ? 'On this computer' : props.attention ? 'May be cleared' : props.usage)}</span>
          </Button>
        ) : (
          <div className="page-sidebar-footer-text">
            <span className="page-sidebar-footer-name">{props.folderName ?? props.location}</span>
            <span className="page-sidebar-footer-meta">{props.blocked ?? (props.folderName ? 'On this computer' : props.attention ? 'May be cleared' : props.usage)}</span>
          </div>
        )}
        <Button
          className="ws-icon-btn"
          aria-label={props.night ? 'Switch to day' : 'Switch to night'}
          title={props.night ? 'Switch to day' : 'Switch to night'}
          onClick={props.onToggleTheme}
        >
          <Icon name={props.night ? 'moon' : 'sun'} />
        </Button>
        <Button className="ws-icon-btn" aria-label="Settings" title="Settings" onClick={props.onSettings}>
          <Icon name="gear" />
        </Button>
        <Button className="ws-icon-btn" aria-label="Help" title="Help" onClick={props.onHelp}>
          <Icon name="help" />
        </Button>
      </div>

      <div className="page-sidebar-toggle-wrap">
        <Button
          className="page-sidebar-toggle"
          aria-label="Collapse the sidebar"
          aria-pressed={collapsed}
          title={`${collapsed ? 'Expand' : 'Collapse'} (${props.collapseShortcut})`}
          aria-keyshortcuts="Meta+Backslash Control+Backslash"
          onClick={props.onToggleCollapsed}
        >
          <span className="page-sidebar-toggle-icon" aria-hidden="true">
            {collapsed ? '»' : '«'}
          </span>
          <span className="page-sidebar-toggle-label">{collapsed ? 'expand' : 'collapse'}</span>
        </Button>
      </div>
    </aside>
  );
}
