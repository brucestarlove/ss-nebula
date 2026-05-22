import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FlyoutItem, FlyoutSectionLabel, FlyoutSeparator } from '@starlove/ui-react';
import { PERSONAL_LIBRARY_ID, type LibraryCollection } from '../excalidraw/library';

export type LibraryControlsProps = {
  collections: LibraryCollection[];
  activeId: string;
  hasSelection: boolean;
  onSwitch: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onSaveToFile: (id: string) => void;
  onPublish: () => void;
  onAddSelectionTo: (id: string) => void;
  onNewFromSelection: (name: string) => void;
};

type Anchor = { top: number; right: number };

/**
 * Custom Nebula library controls rendered into Excalidraw's top bar (via
 * `renderTopRightUI`), immediately left of the native Library button: a library
 * switcher chip for managing named collections, and a selection-aware "Add"
 * button. Their dropdowns mirror the top-rail Canvases menu and are portaled to
 * <body> so Excalidraw's overflow/stacking and scoped CSS reset don't touch them.
 * Action confirmations surface in a small toast pinned top-right by the buttons.
 */
export function LibraryControls({
  collections,
  activeId,
  hasSelection,
  onSwitch,
  onCreate,
  onRename,
  onDelete,
  onSaveToFile,
  onPublish,
  onAddSelectionTo,
  onNewFromSelection,
}: LibraryControlsProps) {
  const active = collections.find((collection) => collection.id === activeId) ?? collections[0];
  const activeName = active?.name ?? 'Library';
  const activeIsPersonal = (active?.id ?? PERSONAL_LIBRARY_ID) === PERSONAL_LIBRARY_ID;

  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4000);
  }, []);
  useEffect(
    () => () => {
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  const promptName = useCallback((message: string, fallback = ''): string | null => {
    if (typeof window === 'undefined') return null;
    const value = window.prompt(message, fallback);
    if (value === null) return null;
    return value.trim();
  }, []);

  return (
    <div className="nebula-library-controls">
      {hasSelection ? (
        <Dropdown
          label={
            <>
              <span aria-hidden="true">＋</span>
              <span className="nebula-library-trigger__label">Add</span>
            </>
          }
          ariaLabel="Add selection to library"
          triggerClassName="nebula-library-trigger nebula-library-trigger--add"
        >
          {(close) => (
            <>
              <FlyoutSectionLabel>Add selection to</FlyoutSectionLabel>
              {collections.map((collection) => (
                <FlyoutItem
                  key={collection.id}
                  onClick={() => {
                    onAddSelectionTo(collection.id);
                    showNotice(`Added selection to “${collection.name}”.`);
                    close();
                  }}
                >
                  <span className="nebula-board-flyout__name">{collection.name}</span>
                  <span className="nebula-board-flyout__meta">{itemCountLabel(collection)}</span>
                </FlyoutItem>
              ))}
              <FlyoutSeparator />
              <FlyoutItem
                className="nebula-board-flyout__create"
                onClick={() => {
                  const name = promptName('Name your new library', 'Untitled library');
                  if (name) {
                    onNewFromSelection(name);
                    showNotice(`Created “${name}” from selection.`);
                  }
                  close();
                }}
              >
                <span aria-hidden="true">＋</span> New library from selection…
              </FlyoutItem>
            </>
          )}
        </Dropdown>
      ) : null}

      <Dropdown
        label={
          <>
            <span className="nebula-library-trigger__icon" aria-hidden="true">▦</span>
            <span className="nebula-library-trigger__label">{activeName}</span>
            <span className="nebula-library-trigger__caret" aria-hidden="true">▾</span>
          </>
        }
        ariaLabel="Switch or manage libraries"
        triggerClassName="nebula-library-trigger nebula-library-trigger--switch"
      >
        {(close) => (
          <>
            <FlyoutSectionLabel>Libraries</FlyoutSectionLabel>
            {collections.map((collection) => (
              <FlyoutItem
                key={collection.id}
                role="menuitemradio"
                aria-checked={collection.id === activeId}
                active={collection.id === activeId}
                onClick={() => {
                  onSwitch(collection.id);
                  close();
                }}
              >
                <span className="nebula-board-flyout__name">{collection.name}</span>
                <span className="nebula-board-flyout__meta">{itemCountLabel(collection)}</span>
              </FlyoutItem>
            ))}
            <FlyoutSeparator />
            <FlyoutItem
              className="nebula-board-flyout__create"
              onClick={() => {
                const name = promptName('Name your new library', 'Untitled library');
                if (name) {
                  onCreate(name);
                  showNotice(`Created “${name}”.`);
                }
                close();
              }}
            >
              <span aria-hidden="true">＋</span> New library…
            </FlyoutItem>
            <FlyoutItem
              onClick={() => {
                const name = promptName('Rename library', activeName);
                if (name) {
                  onRename(activeId, name);
                  showNotice(`Renamed to “${name}”.`);
                }
                close();
              }}
            >
              Rename “{activeName}”…
            </FlyoutItem>
            <FlyoutItem
              disabled={activeIsPersonal}
              title={activeIsPersonal ? 'Personal Library can’t be deleted' : undefined}
              onClick={() => {
                if (activeIsPersonal) return;
                if (typeof window !== 'undefined' && !window.confirm(`Delete the library “${activeName}”?`)) {
                  return;
                }
                onDelete(activeId);
                showNotice(`Deleted “${activeName}”.`);
                close();
              }}
            >
              Delete “{activeName}”
            </FlyoutItem>
            <FlyoutSeparator />
            <FlyoutItem
              onClick={() => {
                onSaveToFile(activeId);
                showNotice(`Saved “${activeName}” to .excalidrawlib.`);
                close();
              }}
            >
              Save to .excalidrawlib…
            </FlyoutItem>
            <FlyoutItem
              onClick={() => {
                onPublish();
                showNotice('Opened the Excalidraw submission guide in a new tab.');
                close();
              }}
            >
              Submit to Excalidraw library ↗
            </FlyoutItem>
          </>
        )}
      </Dropdown>

      {notice && typeof document !== 'undefined'
        ? createPortal(
            <div className="nebula-library-toast" role="status" aria-live="polite">
              {notice}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function itemCountLabel(collection: LibraryCollection): string {
  const count = collection.items.length;
  return `${count} item${count === 1 ? '' : 's'}`;
}

type DropdownProps = {
  label: ReactNode;
  ariaLabel: string;
  triggerClassName: string;
  children: (close: () => void) => ReactNode;
};

/** Trigger button in the Excalidraw top bar with a body-portaled flyout panel. */
function Dropdown({ label, ariaLabel, triggerClassName, children }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);

  const reposition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, close, reposition]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {open && anchor && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={panelRef}
              className="flyout nebula-board-flyout nebula-library-flyout is-open"
              role="menu"
              style={{ position: 'fixed', top: anchor.top, right: anchor.right }}
            >
              {children(close)}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export default LibraryControls;
