import { useState, type DragEvent, type KeyboardEvent } from 'react';
import type { FileKind } from '../../files/types';
import { describeName } from '../paths';
import { iconForFile } from './fileIcon';
import { Button } from './Button';
import { Icon } from './icons';
import { tabId } from './ui';
import { basename } from '../../files/paths';

const TAB_TYPE = 'application/x-nebula-tab';

export type TabMeta = { dirty?: boolean; status?: string };

type TabsProps = {
  tabs: string[];
  active: string | null;
  kinds: Readonly<Record<string, FileKind>>;
  meta: Readonly<Record<string, TabMeta>>;
  panelOpen: boolean;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onMove: (path: string, to: number) => void;
  onNewNote: () => void;
  onTogglePanel: () => void;
  onMenu: (path: string, at: { x: number; y: number }) => void;
};

/** Open files, like Obsidian's tabs: a click focuses, the × or a middle
 * click closes, dragging reorders, and a dot marks unsaved edits. Arrows
 * move between tabs; Delete closes the focused one. */
export function Tabs({ tabs, active, kinds, meta, panelOpen, onActivate, onClose, onMove, onNewNote, onTogglePanel, onMenu }: TabsProps) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ path: string; after: boolean } | null>(null);

  // Focus moves at once (every tab is already on the page), so a quick
  // second key lands on the new tab.
  const focusTab = (path: string) => {
    document.getElementById(tabId(path))?.focus();
    onActivate(path);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, path: string) => {
    const index = tabs.indexOf(path);
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        focusTab(tabs[(index + 1) % tabs.length]);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        focusTab(tabs[(index - 1 + tabs.length) % tabs.length]);
        break;
      case 'Home':
        event.preventDefault();
        focusTab(tabs[0]);
        break;
      case 'End':
        event.preventDefault();
        focusTab(tabs[tabs.length - 1]);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        onActivate(path);
        break;
      case 'Delete': {
        event.preventDefault();
        const next = tabs[index + 1] ?? tabs[index - 1];
        if (next) document.getElementById(tabId(next))?.focus();
        onClose(path);
        break;
      }
      default:
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          onMenu(path, { x: rect.left + 12, y: rect.bottom - 2 });
        }
    }
  };

  const dropAt = (event: DragEvent<HTMLDivElement>, path: string) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { path, after: event.clientX > rect.left + rect.width / 2 };
  };

  return (
    <header className="ws-tabs">
      <div className="ws-tablist" role="tablist" aria-label="Open files">
        {tabs.map((path) => {
          const selected = path === active;
          const name = basename(path);
          const { label } = describeName(name);
          const shown = describeName(name).tag ? name : label;
          const dirty = meta[path]?.dirty === true;
          return (
            <div
              key={path}
              id={tabId(path)}
              className="ws-tab"
              role="tab"
              aria-selected={selected}
              aria-controls={selected ? 'ws-stage' : undefined}
              aria-keyshortcuts="Delete"
              tabIndex={selected || (!active && path === tabs[0]) ? 0 : -1}
              title={path}
              draggable
              data-dirty={dirty ? '' : undefined}
              data-dragging={dragging === path ? '' : undefined}
              data-drop-before={drop?.path === path && !drop.after ? '' : undefined}
              data-drop-after={drop?.path === path && drop.after ? '' : undefined}
              onClick={() => onActivate(path)}
              onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  onClose(path);
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                onMenu(path, { x: event.clientX, y: event.clientY });
              }}
              onKeyDown={(event) => onKeyDown(event, path)}
              onDragStart={(event) => {
                event.dataTransfer.setData(TAB_TYPE, path);
                event.dataTransfer.effectAllowed = 'move';
                setDragging(path);
              }}
              onDragEnd={() => {
                setDragging(null);
                setDrop(null);
              }}
              onDragOver={(event) => {
                if (!dragging || ![...event.dataTransfer.types].includes(TAB_TYPE)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDrop(dropAt(event, path));
              }}
              onDrop={(event) => {
                if (!dragging) return;
                event.preventDefault();
                const target = dropAt(event, path);
                const others = tabs.filter((tab) => tab !== dragging);
                const index = others.indexOf(target.path) + (target.after ? 1 : 0);
                if (target.path !== dragging) onMove(dragging, index);
                setDragging(null);
                setDrop(null);
              }}
            >
              <Icon name={iconForFile(name, kinds[path] ?? 'other')} />
              <span className="ws-tab-name">{shown}</span>
              {dirty ? (
                <>
                  <span className="ws-tab-dirty" aria-hidden="true" />
                  <span className="ws-visually-hidden">, unsaved changes</span>
                </>
              ) : null}
              <span
                className="ws-tab-close"
                aria-hidden="true"
                title={`Close ${shown}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(path);
                }}
              >
                <Icon name="close" />
              </span>
            </div>
          );
        })}
      </div>
      <Button className="ws-icon-btn" aria-label="New note" title="New note" onClick={onNewNote}>
        <Icon name="plus" />
      </Button>
      <span className="ws-tabs-spacer" />
      <Button
        className="ws-icon-btn"
        aria-label="Outline"
        title="Outline"
        aria-pressed={panelOpen}
        aria-controls={panelOpen ? 'ws-panel' : undefined}
        onClick={onTogglePanel}
      >
        <Icon name="panel" />
      </Button>
    </header>
  );
}
