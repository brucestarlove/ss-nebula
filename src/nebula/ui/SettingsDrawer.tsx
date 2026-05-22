import { useEffect, useRef, useState } from 'react';
import { ThemeSwitcher } from './ThemeSwitcher';
import type { ResolvedTheme } from './useTheme';
import type { Flavor } from './useBackground';
import { useMotion } from './useMotion';

type SettingsDrawerProps = {
  open: boolean;
  onClose: () => void;
  themeResolved: ResolvedTheme;
  onActivateTheme: (theme: ResolvedTheme) => void;
  isPlain: boolean;
  setFlavor: (flavor: Flavor) => void;
  onExport: () => void;
  onExportNebulaDocument: () => void;
  onExportObsidianMarkdown: () => void;
  onImport: (file: File) => void;
};

type SettingsTab = 'appearance' | 'repository';

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'repository', label: 'Repository' },
];

/** Right-anchored settings sheet split into Appearance (theme + motion) and
 *  Repository (canvas backup + about) tabs. Excalidraw libraries are managed
 *  from the Library button on the canvas, not here. */
export function SettingsDrawer({
  open,
  onClose,
  themeResolved,
  onActivateTheme,
  isPlain,
  setFlavor,
  onExport,
  onExportNebulaDocument,
  onExportObsidianMarkdown,
  onImport,
}: SettingsDrawerProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [tab, setTab] = useState<SettingsTab>('appearance');
  const { enabled: motionEnabled, setEnabled: setMotionEnabled } = useMotion();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  return (
    <>
      <div
        className={`drawer-backdrop${open ? ' is-visible' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Settings sheet — mirrors ss-orbit's drawer: the `is-settings` variant
          lays the title, close, and tab strip into the header grid; panels live
          in `.drawer-inner` as grouped `.drawer-section` blocks. */}
      <aside
        className={`drawer is-settings is-wide nebula-settings-drawer${open ? ' is-open' : ''}`}
        role="dialog"
        aria-label="Nebula settings"
        aria-hidden={!open}
      >
        <header className="drawer-header">
          <div className="drawer-title-block">
            <span className="drawer-eyebrow">Settings</span>
            <h2 className="drawer-title">Nebula</h2>
          </div>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close settings">
            ×
          </button>
          <nav className="drawer-tabs" role="tablist" aria-label="Settings sections">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                id={`nebula-settings-tab-${entry.id}`}
                className={`drawer-tab${tab === entry.id ? ' is-active' : ''}`}
                aria-selected={tab === entry.id}
                aria-controls={`nebula-settings-panel-${entry.id}`}
                onClick={() => setTab(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </nav>
        </header>

        <div className="drawer-inner">
          {tab === 'appearance' ? (
            <section
              role="tabpanel"
              id="nebula-settings-panel-appearance"
              aria-labelledby="nebula-settings-tab-appearance"
            >
              <div className="drawer-section">
                <h3 className="nebula-settings-heading">Theme</h3>
                <p className="form-help">Switch between light and dark.</p>
                <ThemeSwitcher value={themeResolved} onActivate={onActivateTheme} isPlain={isPlain} size="lg" />
              </div>

              <div className="drawer-section">
                <h3 className="nebula-settings-heading">Background</h3>
                <div className="segmented" role="radiogroup" aria-label="Background style" data-size="lg">
                  <button
                    type="button"
                    className="segmented-option"
                    role="radio"
                    aria-checked={!isPlain}
                    onClick={() => setFlavor('rich')}
                  >
                    {themeResolved === 'dark' ? 'Starfield' : 'Parchment'}
                  </button>
                  <button
                    type="button"
                    className="segmented-option"
                    role="radio"
                    aria-checked={isPlain}
                    onClick={() => setFlavor('plain')}
                  >
                    {themeResolved === 'dark' ? 'Plain black' : 'Plain white'}
                  </button>
                </div>
                <p className="form-help">
                  {themeResolved === 'dark'
                    ? 'Atmospheric shows the starfield; plain is a flat black canvas.'
                    : 'Atmospheric shows the parchment texture; plain is a flat white canvas.'}{' '}
                  Saved per theme.
                </p>
              </div>

              <div className="drawer-section">
                <h3 className="nebula-settings-heading">Motion</h3>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={motionEnabled}
                    onChange={(event) => setMotionEnabled(event.target.checked)}
                  />
                  <span className="switch-track" aria-hidden="true" />
                  <span className="switch-label">Animated background</span>
                </label>
                <p className="form-help">
                  Runs the drifting starfield, meteors, and nebula motion. Off by default — the
                  animation can be distracting while drawing. Static colors stay either way.
                </p>
              </div>
            </section>
          ) : (
            <section
              role="tabpanel"
              id="nebula-settings-panel-repository"
              aria-labelledby="nebula-settings-tab-repository"
            >
              <div className="drawer-section">
                <h3 className="nebula-settings-heading">Canvas data</h3>
                <p className="form-help">Back up or restore this canvas as a Nebula document, pure .excalidraw file, or Obsidian Excalidraw markdown drawing.</p>
                <div className="deployment-actions">
                  <button type="button" className="btn-secondary" onClick={onExportNebulaDocument}>
                    Export Nebula .nebula.json
                  </button>
                  <button type="button" className="btn-secondary" onClick={onExport}>
                    Export .excalidraw
                  </button>
                  <button type="button" className="btn-secondary" onClick={onExportObsidianMarkdown}>
                    Export Obsidian .excalidraw.md
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Import Excalidraw / Obsidian
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".excalidraw,.md,.excalidraw.md,application/json,text/markdown,text/plain"
                    hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) onImport(file);
                      event.currentTarget.value = '';
                    }}
                  />
                </div>
              </div>

              <div className="drawer-section">
                <h3 className="nebula-settings-heading">About Nebula</h3>
                <p className="form-help">
                  Nebula is the Starscape canvas surface — an Excalidraw workspace wrapped in the
                  shared Starscape shell. Scenes are saved locally per board and canvas.
                </p>
              </div>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}

export default SettingsDrawer;
