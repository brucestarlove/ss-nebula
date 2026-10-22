import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { kindFromName } from '../../files/kinds';
import type { FileKind } from '../../files/types';
import { dirname, isInside } from '../../files/paths';
import { visibleNodes, type TreeNode } from '../tree';
import { iconForFile } from './fileIcon';
import { Icon } from './icons';
import { isContextMenuKey, menuAtElement, type MenuAt } from './ui';
import { hasMod } from './ui';

const DRAG_TYPE = 'application/x-nebula-path';

export type FileTreeProps = {
  tree: TreeNode[];
  expanded: ReadonlySet<string>;
  activePath: string | null;
  kinds: Readonly<Record<string, FileKind>>;
  renaming: string | null;
  /** Bumped to move keyboard focus to a row (after New note, say). */
  focusRequest: { path: string; n: number } | null;
  onOpen: (path: string) => void;
  onToggle: (path: string) => void;
  onExpand: (path: string, expanded: boolean) => void;
  onStartRename: (path: string) => void;
  /** Resolves to an error to show, or null once renamed. */
  onRename: (path: string, name: string) => Promise<string | null>;
  onCancelRename: () => void;
  onDelete: (path: string) => void;
  onMenu: (path: string | null, at: MenuAt) => void;
  onMove: (from: string, folder: string) => void;
  onDropFiles: (files: File[], folder: string) => void;
};

/** The project's files as an ARIA tree: folders first, A to Z; arrows move,
 * Right and Left open and close folders, Enter opens, F2 renames, Delete
 * deletes, and letters jump. One row is in the tab order at a time. */
export function FileTree(props: FileTreeProps) {
  const { tree, expanded, activePath, renaming, focusRequest } = props;
  const rows = useMemo(() => visibleNodes(tree, expanded), [tree, expanded]);
  const rowsByPath = useMemo(() => new Map(rows.map((row) => [row.node.path, row])), [rows]);
  const elements = useRef(new Map<string, HTMLElement>());
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const typeahead = useRef({ text: '', at: 0 });

  const tabbable =
    (focusPath && rowsByPath.has(focusPath) && focusPath) ||
    (activePath && rowsByPath.has(activePath) && activePath) ||
    rows[0]?.node.path ||
    null;

  const focusRow = useCallback((path: string) => {
    setFocusPath(path);
    elements.current.get(path)?.focus();
  }, []);

  // A row asked for from outside (a new file, a revealed one) takes focus
  // once it's on screen.
  const handled = useRef(0);
  useEffect(() => {
    if (!focusRequest || focusRequest.n === handled.current) return;
    if (!rowsByPath.has(focusRequest.path)) return;
    handled.current = focusRequest.n;
    focusRow(focusRequest.path);
  }, [focusRequest, rowsByPath, focusRow]);

  const register = (path: string) => (element: HTMLElement | null) => {
    if (element) elements.current.set(path, element);
    else elements.current.delete(path);
  };

  /* ---- keyboard ---------------------------------------------------- */

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).tagName === 'INPUT') return;
    const current = tabbable ? rowsByPath.get(tabbable) : undefined;
    if (!current) return;
    const index = rows.indexOf(current);
    const node = current.node;
    const isDir = node.type === 'dir';
    const open = isDir && expanded.has(node.path);

    const go = (path: string | undefined) => {
      if (!path) return;
      event.preventDefault();
      focusRow(path);
    };

    switch (event.key) {
      case 'ArrowDown':
        return go(rows[index + 1]?.node.path);
      case 'ArrowUp':
        return go(rows[index - 1]?.node.path);
      case 'Home':
        return go(rows[0]?.node.path);
      case 'End':
        return go(rows[rows.length - 1]?.node.path);
      case 'ArrowRight':
        event.preventDefault();
        if (isDir && !open) props.onExpand(node.path, true);
        else if (open && node.children[0]) focusRow(node.children[0].path);
        return;
      case 'ArrowLeft':
        event.preventDefault();
        if (open) props.onExpand(node.path, false);
        else if (current.parent) focusRow(current.parent);
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (isDir) props.onToggle(node.path);
        else props.onOpen(node.path);
        return;
      case 'F2':
        event.preventDefault();
        props.onStartRename(node.path);
        return;
      case 'Delete':
        event.preventDefault();
        props.onDelete(node.path);
        return;
      case 'Backspace':
        if (hasMod(event)) {
          event.preventDefault();
          props.onDelete(node.path);
        }
        return;
      default:
        break;
    }

    if (isContextMenuKey(event)) {
      event.preventDefault();
      const element = elements.current.get(node.path);
      if (element) props.onMenu(node.path, menuAtElement(element));
      return;
    }

    // Letters jump to the next row whose name starts with them.
    if (event.key.length === 1 && !event.altKey && !hasMod(event) && /\S/.test(event.key)) {
      const now = Date.now();
      const state = typeahead.current;
      state.text = now - state.at > 600 ? event.key.toLowerCase() : state.text + event.key.toLowerCase();
      state.at = now;
      const order = [...rows.slice(index + (state.text.length === 1 ? 1 : 0)), ...rows];
      const hit = order.find((row) => row.node.label.toLowerCase().startsWith(state.text));
      if (hit) go(hit.node.path);
    }
  };

  /* ---- drag and drop ----------------------------------------------- */

  const acceptsDrop = (event: DragEvent, folder: string): boolean => {
    const types = [...event.dataTransfer.types];
    if (types.includes('Files')) return true;
    if (!types.includes(DRAG_TYPE) || !dragging) return false;
    if (isInside(folder, dragging)) return false;
    return dirname(dragging) !== folder;
  };

  const onDragOver = (folder: string) => (event: DragEvent) => {
    event.stopPropagation();
    if (!acceptsDrop(event, folder)) {
      setDropTarget(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = [...event.dataTransfer.types].includes('Files') ? 'copy' : 'move';
    setDropTarget(folder);
  };

  const onDrop = (folder: string) => (event: DragEvent) => {
    event.stopPropagation();
    event.preventDefault();
    setDropTarget(null);
    const files = [...event.dataTransfer.files];
    if (files.length > 0) props.onDropFiles(files, folder);
    else if (dragging && acceptsDrop(event, folder)) props.onMove(dragging, folder);
    setDragging(null);
  };

  const dragProps = (node: TreeNode) => {
    const folder = node.type === 'dir' ? node.path : dirname(node.path);
    return {
      draggable: renaming !== node.path,
      onDragStart: (event: DragEvent) => {
        event.stopPropagation();
        event.dataTransfer.setData(DRAG_TYPE, node.path);
        event.dataTransfer.setData('text/plain', node.name);
        event.dataTransfer.effectAllowed = 'move';
        setDragging(node.path);
      },
      onDragEnd: () => {
        setDragging(null);
        setDropTarget(null);
      },
      onDragOver: onDragOver(folder),
      onDrop: onDrop(folder),
    };
  };

  const rootDrop = {
    onDragOver: onDragOver(''),
    onDrop: onDrop(''),
    onDragLeave: (event: DragEvent) => {
      if (!(event.currentTarget as Node).contains(event.relatedTarget as Node | null)) setDropTarget(null);
    },
  };

  /* ---- rows -------------------------------------------------------- */

  const openMenu = (path: string) => (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    focusRow(path);
    props.onMenu(path, { x: event.clientX, y: event.clientY });
  };

  const renderNodes = (nodes: TreeNode[], level: number) =>
    nodes.map((node, index) => {
      const common = {
        role: 'treeitem' as const,
        'aria-level': level,
        'aria-setsize': nodes.length,
        'aria-posinset': index + 1,
        tabIndex: node.path === tabbable ? 0 : -1,
        'data-path': node.path,
        onFocus: (event: FocusEvent) => {
          if (event.target === event.currentTarget) setFocusPath(node.path);
        },
      };
      const label =
        renaming === node.path ? (
          <RenameInput
            key="rename"
            initial={node.type === 'dir' ? node.name : node.label}
            name={node.name}
            onCommit={(name) => props.onRename(node.path, name)}
            onCancel={props.onCancelRename}
          />
        ) : (
          <span className="page-sidebar-nav-label">{node.label}</span>
        );

      // The row is the treeitem; the wrappers around a folder's children are
      // plain divs, so each row's name is its own text (aria-level carries
      // the nesting), not the text of everything inside the folder.
      if (node.type === 'dir') {
        const open = expanded.has(node.path);
        return (
          <div key={node.path} className="page-sidebar-nav-group" data-expanded={open ? '' : undefined}>
            <div
              {...common}
              ref={register(node.path)}
              className="page-sidebar-nav-item page-sidebar-nav-parent ws-folder"
              aria-expanded={open}
              aria-selected={false}
              data-drop-target={dropTarget === node.path ? '' : undefined}
              data-dragging={dragging === node.path ? '' : undefined}
              onClick={() => {
                if (renaming === node.path) return;
                focusRow(node.path);
                props.onToggle(node.path);
              }}
              onContextMenu={openMenu(node.path)}
              {...dragProps(node)}
            >
              <span className="page-sidebar-nav-icon">
                <Icon name="chevron" className="ws-chevron" />
              </span>
              {label}
              {!open && node.fileCount > 0 && renaming !== node.path ? (
                <span className="ws-ext" aria-hidden="true">
                  {node.fileCount}
                </span>
              ) : null}
            </div>
            {open && node.children.length > 0 ? (
              <div className="page-sidebar-nav-children">
                <div className="page-sidebar-nav-children-inner">{renderNodes(node.children, level + 1)}</div>
              </div>
            ) : null}
          </div>
        );
      }

      const active = node.path === activePath;
      const kind = props.kinds[node.path] ?? kindFromName(node.name);
      return (
        <div
          key={node.path}
          {...common}
          ref={register(node.path)}
          className="page-sidebar-nav-item"
          data-active={active ? '' : undefined}
          data-dragging={dragging === node.path ? '' : undefined}
          aria-selected={active}
          onClick={() => {
            if (renaming === node.path) return;
            setFocusPath(node.path);
            props.onOpen(node.path);
          }}
          onContextMenu={openMenu(node.path)}
          {...dragProps(node)}
        >
          <span className="page-sidebar-nav-icon">
            <Icon name={iconForFile(node.name, kind)} />
          </span>
          {label}
          {node.tag && renaming !== node.path ? <span className="ws-ext">{node.tag}</span> : null}
        </div>
      );
    });

  return (
    <div
      className="ws-files-drop"
      {...rootDrop}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onMenu(null, { x: event.clientX, y: event.clientY });
      }}
    >
      <div
        className="ws-filetree"
        role="tree"
        aria-label="Files"
        data-drop-root={dropTarget === '' ? '' : undefined}
        onKeyDown={onKeyDown}
      >
        {renderNodes(tree, 1)}
      </div>
      {tree.length === 0 ? <p className="ws-tree-empty">No files yet. Make a note or a canvas, or drop files here.</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

type RenameInputProps = {
  initial: string;
  name: string;
  onCommit: (name: string) => Promise<string | null>;
  onCancel: () => void;
};

function RenameInput({ initial, name, onCommit, onCancel }: RenameInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = async (fromBlur: boolean) => {
    if (done.current) return;
    if (value === initial) {
      done.current = true;
      onCancel();
      return;
    }
    done.current = true;
    const problem = await onCommit(value);
    if (!problem) return;
    if (fromBlur) {
      onCancel();
      return;
    }
    done.current = false;
    setError(problem);
    ref.current?.focus();
  };

  return (
    <input
      ref={ref}
      className="ws-rename-input"
      data-escape-own=""
      value={value}
      aria-label={`Rename ${name}`}
      aria-invalid={error ? true : undefined}
      title={error ?? undefined}
      spellCheck={false}
      autoComplete="off"
      onChange={(event) => {
        setValue(event.target.value);
        setError(null);
      }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          void commit(false);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          done.current = true;
          onCancel();
        }
      }}
      onBlur={() => void commit(true)}
    />
  );
}
