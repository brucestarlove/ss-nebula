import { useState, type ReactNode } from 'react';
import { Button, Topbar, TopbarBrand } from '@starlove/ui-react';
import { AboutDialog } from './AboutDialog';
import { CanvasDropdown } from './CanvasDropdown';
import { SettingsDrawer } from './SettingsDrawer';
import { ThemeSwitcher } from './ThemeSwitcher';
import { NEBULA_LOGO_SRC } from './logo';
import type { ResolvedTheme } from './useTheme';
import type { Flavor } from './useBackground';
import type { CanvasSummary } from '../storage/types';

type NebulaShellProps = {
  boardName: string;
  canvases: CanvasSummary[];
  activeCanvasId: string;
  onSelectCanvas: (canvasId: string) => void;
  onCreateCanvas: () => void;
  themeResolved: ResolvedTheme;
  /** Click inactive theme → switch; click active theme → toggle its flavor. */
  onActivateTheme: (theme: ResolvedTheme) => void;
  isPlain: boolean;
  setFlavor: (flavor: Flavor) => void;
  onExport: () => void;
  onExportNebulaDocument: () => void;
  onExportObsidianMarkdown: () => void;
  onImport: (file: File) => void;
  onOpenSearch: () => void;
  children: ReactNode;
};

/**
 * Starscape app shell for Nebula: top rail (logo, New Canvas, board dropdown,
 * theme switcher, settings, right-aligned search) + footer, wrapping the
 * Excalidraw canvas in an Orbit-style framed board.
 */
export function NebulaShell({
  boardName,
  canvases,
  activeCanvasId,
  onSelectCanvas,
  onCreateCanvas,
  themeResolved,
  onActivateTheme,
  isPlain,
  setFlavor,
  onExport,
  onExportNebulaDocument,
  onExportObsidianMarkdown,
  onImport,
  onOpenSearch,
  children,
}: NebulaShellProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <div className="nebula-app">
      <div className="grain" aria-hidden="true">
        <div className="milky-way" />
      </div>

      {/* scrollAware off: the Nebula shell never scrolls the window, so the
          topbar's glass-on-scroll effect would never fire — keep it inert. */}
      <Topbar className="nebula-topbar" scrollAware={false}>
        <TopbarBrand className="brand nebula-brand">
          <img className="mark nebula-logo" src={NEBULA_LOGO_SRC} alt="Nebula" />
        </TopbarBrand>

        <div className="controls nebula-controls">
          <span className="topbar-controls-gap" />

          <div className="topbar-search nebula-search">
            {/* Opens Excalidraw's native "Find on canvas" panel; the user types there. */}
            <input
              type="search"
              placeholder="Find on canvas…"
              aria-label="Find text on canvas"
              readOnly
              onMouseDown={(event) => {
                // Don't focus this read-only field; hand off to the native panel.
                event.preventDefault();
                onOpenSearch();
              }}
              onFocus={onOpenSearch}
            />
          </div>

          <Button variant="cta" className="topbar-btn btn-sun topbar-ctl-shrink nebula-new-btn" onClick={onCreateCanvas}>
            <span className="btn-plus" aria-hidden="true">+</span>
            <span className="btn-sun-label">New Canvas</span>
          </Button>

          <CanvasDropdown
            label={boardName}
            canvases={canvases}
            activeCanvasId={activeCanvasId}
            onSelectCanvas={onSelectCanvas}
            onCreateCanvas={onCreateCanvas}
          />

          <div className="topbar-ctl-shrink nebula-theme-switch">
            <ThemeSwitcher value={themeResolved} onActivate={onActivateTheme} isPlain={isPlain} />
          </div>

          <Button
            variant="translucent"
            className="topbar-btn topbar-ctl-shrink nebula-help-btn"
            onClick={() => setHelpOpen(true)}
            aria-label="Help & about"
            aria-haspopup="dialog"
          >
            <svg
              className="topbar-icon"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
              <path d="M12 17h.01" />
            </svg>
            <span className="nebula-help-btn__label">Help</span>
          </Button>

          <Button
            variant="translucent"
            className="topbar-btn topbar-ctl-shrink nebula-settings-btn"
            onClick={() => setSettingsOpen(true)}
          >
            <svg
              className="topbar-icon"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <span className="nebula-settings-btn__label">Settings</span>
          </Button>
        </div>
      </Topbar>

      <main className="nebula-main">
        <div className="nebula-board">{children}</div>
      </main>

      <footer className="frame-footer" aria-label="Application signature">
        <span className="frame-footer-title">Nebula</span>
        <span className="frame-footer-subtitle">
          <em>a Starscape app</em>
        </span>
      </footer>

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        themeResolved={themeResolved}
        onActivateTheme={onActivateTheme}
        isPlain={isPlain}
        setFlavor={setFlavor}
        onExport={onExport}
        onExportNebulaDocument={onExportNebulaDocument}
        onExportObsidianMarkdown={onExportObsidianMarkdown}
        onImport={onImport}
      />

      <AboutDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

export default NebulaShell;
