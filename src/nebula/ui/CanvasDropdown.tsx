import { useRef } from 'react';
import { useClickOutside, useDisclosure, useEscapeKey } from '@starlove/ui-react';
import type { CanvasSummary } from '../storage/types';

type CanvasDropdownProps = {
  label: string;
  canvases: CanvasSummary[];
  activeCanvasId: string;
  onSelectCanvas: (canvasId: string) => void;
  onCreateCanvas: () => void;
};

/**
 * Top-rail "Canvases" menu. Lists the canvases persisted for the current board
 * (from the SceneStore) and offers a "New Canvas" action — mirrors Orbit's
 * board dropdown, but scoped to canvases since Nebula tracks a single board.
 */
export function CanvasDropdown({
  label,
  canvases,
  activeCanvasId,
  onSelectCanvas,
  onCreateCanvas,
}: CanvasDropdownProps) {
  const { isOpen, close, toggle } = useDisclosure(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Dismiss on outside-click / Escape — only while open.
  useClickOutside(containerRef, close, { enabled: isOpen });
  useEscapeKey(close, { enabled: isOpen });

  return (
    <div className="topbar-menu nebula-menu" ref={containerRef}>
      <button
        type="button"
        className="topbar-chip nebula-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={toggle}
      >
        <svg
          className="topbar-icon"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <rect x="4" y="4" width="6" height="16" rx="0.75" stroke="currentColor" strokeWidth="2" />
          <rect x="14" y="4" width="6" height="16" rx="0.75" stroke="currentColor" strokeWidth="2" />
        </svg>
        <span className="topbar-chip-label nebula-menu-trigger__label">{label}</span>
        <span aria-hidden="true">▾</span>
      </button>

      <div
        className="menu-flyout menu-flyout--align-end nebula-canvas-menu"
        role="menu"
        hidden={!isOpen}
      >
        <div className="menu-flyout-head">Canvases</div>
        <div className="menu-flyout-list">
          {canvases.length === 0 ? (
            <div className="menu-flyout-item" aria-disabled="true">
              <span className="menu-flyout-item-title">No saved canvases yet</span>
            </div>
          ) : (
            canvases.map((canvas) => (
              <button
                key={canvas.canvasId}
                type="button"
                role="menuitemradio"
                aria-checked={canvas.canvasId === activeCanvasId}
                className={`menu-flyout-item${canvas.canvasId === activeCanvasId ? ' is-current' : ''}`}
                onClick={() => {
                  onSelectCanvas(canvas.canvasId);
                  close();
                }}
              >
                <span className="menu-flyout-item-title">{canvas.name}</span>
                <span className="menu-flyout-item-meta">{canvas.canvasId}</span>
              </button>
            ))
          )}
          <button
            type="button"
            role="menuitem"
            className="menu-flyout-item nebula-canvas-menu__create"
            onClick={() => {
              onCreateCanvas();
              close();
            }}
          >
            <span className="menu-flyout-item-title">
              <span aria-hidden="true">＋</span> New Canvas
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default CanvasDropdown;
