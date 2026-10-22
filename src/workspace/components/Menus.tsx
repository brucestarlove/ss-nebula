import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  type ContextMenuState,
} from '@starlove/ui-react';
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { ProjectRecord } from '../../files/types';
import { Button, Planet } from './Button';
import { focusFirstMenuItem, handleMenuKeys, useEscapeLayer, useOutsidePress, useReturnFocus } from './hooks';
import { Icon, type IconName } from './icons';
import { Swatches } from './Swatches';
import { clampToViewport, isContextMenuKey, menuAtElement, type MenuAt } from './ui';

type WsContextMenuProps = {
  at: MenuAt | null;
  onClose: () => void;
  label: string;
  className?: string;
  /** A selector for the item to focus first. */
  focus?: string;
  children: ReactNode;
};

/** ss-ui's context menu (the .context-menu surface and .flyout-item rows),
 * placed at the pointer and kept on screen (clamped before the first paint;
 * never hidden while placing, since a hidden item can't take focus), with
 * focus on its first item, Up and Down to move, and Escape, Tab or a press
 * outside to close. */
export function WsContextMenu({ at, onClose, label, className, focus, children }: WsContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const open = at !== null;

  const state = useMemo<ContextMenuState>(
    () => ({
      isOpen: open,
      position: at ?? { x: 0, y: 0 },
      onContextMenu: () => {},
      open: () => {},
      close: onClose,
      menuProps: { style: {} },
    }),
    [open, at, onClose],
  );

  useEscapeLayer(open, onClose);
  useReturnFocus(open, ref);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!at || !node) {
      setPlace(null);
      return;
    }
    const { width, height } = node.getBoundingClientRect();
    setPlace(clampToViewport(at.x, at.y, width, height));
    focusFirstMenuItem(node, focus);
  }, [at, focus]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      onClose();
      return;
    }
    handleMenuKeys(event, ref.current);
  };

  return (
    <ContextMenu
      ref={ref}
      menu={state}
      className={className}
      aria-label={label}
      style={{ left: place?.left ?? at?.x ?? 0, top: place?.top ?? at?.y ?? 0 }}
      onKeyDown={onKeyDown}
      onContextMenu={(event: MouseEvent) => event.preventDefault()}
    >
      {children}
    </ContextMenu>
  );
}

export type MenuEntry =
  | { label: string; icon?: IconName; onSelect: () => void; danger?: boolean; shortcut?: string; keys?: string; disabled?: boolean }
  | 'separator';

/** Rows for a WsContextMenu, from a list. */
export function MenuEntries({ entries }: { entries: MenuEntry[] }) {
  return (
    <>
      {entries.map((entry, index) =>
        entry === 'separator' ? (
          <ContextMenuSeparator key={`sep-${index}`} />
        ) : (
          <ContextMenuItem
            key={entry.label}
            data-variant="ws"
            danger={entry.danger}
            aria-keyshortcuts={entry.keys}
            disabled={entry.disabled}
            onClick={entry.onSelect}
          >
            {entry.icon ? <Icon name={entry.icon} /> : null}
            {entry.label}
            {entry.shortcut ? <kbd aria-hidden="true">{entry.shortcut}</kbd> : null}
          </ContextMenuItem>
        ),
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * The project switcher's menu
 * ------------------------------------------------------------------ */

type ProjectMenuProps = {
  open: boolean;
  projects: ProjectRecord[];
  currentId: string | null;
  location: string;
  dock: boolean;
  anchor: RefObject<HTMLElement | null>;
  onDockChange: (on: boolean) => void;
  onSwitch: (id: string) => void;
  onNewProject: () => void;
  /** False when the project list can't be changed: New project shows,
   * turned off. */
  canCreate?: boolean;
  onProjectMenu: (id: string, at: MenuAt) => void;
  onClose: () => void;
};

/** PROJECTS (with the Dock switch on the right once there are two or more),
 * your projects, then New project. Open a folder and Connect to a Nebula
 * server wait for their slices (docs/slice-3.md, decision 6). */
export function ProjectMenu({
  open,
  projects,
  currentId,
  location,
  dock,
  anchor,
  onDockChange,
  onSwitch,
  onNewProject,
  canCreate = true,
  onProjectMenu,
  onClose,
}: ProjectMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEscapeLayer(open, onClose);
  useOutsidePress(ref, open, onClose, [anchor]);
  useReturnFocus(open, ref);

  useLayoutEffect(() => {
    if (open) focusFirstMenuItem(ref.current, '[role="menuitemradio"][aria-checked="true"]');
  }, [open]);

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      onClose();
      return;
    }
    handleMenuKeys(event, ref.current);
  };

  return (
    <div ref={ref} className="ws-menu ws-surface" role="menu" aria-label="Projects" onKeyDown={onKeyDown}>
      <div className="ws-menu-head">
        <div className="ws-menu-label" aria-hidden="true">
          Projects
        </div>
        {projects.length > 1 ? (
          <Button
            className="switch ws-dock-switch"
            role="menuitemcheckbox"
            aria-checked={dock}
            title="Show your projects as planets down the left edge"
            onClick={() => onDockChange(!dock)}
          >
            <span className="switch-track" aria-hidden="true" />
            <span className="switch-label">Dock</span>
          </Button>
        ) : null}
      </div>
      <div role="group" aria-label="Your projects">
        {projects.map((project) => {
          const current = project.id === currentId;
          return (
            <Button
              key={project.id}
              className="ws-menu-item"
              role="menuitemradio"
              aria-checked={current}
              data-project={project.id}
              onClick={() => onSwitch(project.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                onProjectMenu(project.id, { x: event.clientX, y: event.clientY });
              }}
              onKeyDown={(event) => {
                if (!isContextMenuKey(event)) return;
                event.preventDefault();
                onProjectMenu(project.id, menuAtElement(event.currentTarget));
              }}
            >
              <Planet color={project.color} />
              <span className="ws-menu-item-text">
                <b>{project.name}</b>
                <span>{location}</span>
              </span>
              {current ? <Icon name="check" className="ws-tick" /> : null}
            </Button>
          );
        })}
      </div>
      <div className="ws-menu-sep" role="separator" />
      <Button className="ws-menu-action" role="menuitem" disabled={!canCreate} onClick={onNewProject}>
        <Icon name="plus" />
        New project
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * A project's own right-click menu
 * ------------------------------------------------------------------ */

type ProjectContextMenuProps = {
  project: ProjectRecord | null;
  at: MenuAt | null;
  canDownload: boolean;
  onColour: (colour: string) => void;
  onRename: () => void;
  onSettings: () => void;
  onDownload: () => void;
  onRemove: () => void;
  onClose: () => void;
  /** False when the project list can't be changed (a registry from a newer
   * Nebula): rename, colour and remove show, turned off. */
  canChange?: boolean;
};

/** Right-click on the project (its name, its planet in the dock, its row in
 * the menu): its name, its colour, then Rename, Project settings, Download
 * as .zip and Remove project. */
export function ProjectContextMenu({
  project,
  at,
  canDownload,
  onColour,
  onRename,
  onSettings,
  onDownload,
  onRemove,
  onClose,
  canChange = true,
}: ProjectContextMenuProps) {
  const entries: MenuEntry[] = [
    { label: 'Rename…', icon: 'pencil', onSelect: onRename, shortcut: 'F2', keys: 'F2', disabled: !canChange },
    { label: 'Project settings…', icon: 'gear', onSelect: onSettings },
    ...(canDownload ? [{ label: 'Download as .zip', icon: 'download' as const, onSelect: onDownload }] : []),
    'separator',
    { label: 'Remove project…', icon: 'trash', onSelect: onRemove, danger: true, disabled: !canChange },
  ];
  return (
    <WsContextMenu
      at={project ? at : null}
      onClose={onClose}
      label={project?.name ?? 'Project'}
      className="ws-context"
      focus='[role="menuitemradio"][aria-checked="true"]'
    >
      {project ? (
        <div
          onKeyDown={(event) => {
            if (event.key === 'F2') {
              event.preventDefault();
              if (canChange) onRename();
            }
          }}
        >
          <div className="ws-context-head" aria-hidden="true">
            <Planet color={project.color} />
            <b>{project.name}</b>
          </div>
          <ContextMenuSeparator />
          <div className="flyout-section-label" aria-hidden="true">
            Colour
          </div>
          <Swatches variant="menu" value={project.color} onChange={onColour} label="Colour" disabled={!canChange} />
          <ContextMenuSeparator />
          <MenuEntries entries={entries} />
        </div>
      ) : null}
    </WsContextMenu>
  );
}
