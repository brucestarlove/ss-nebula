import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { Preferences, ProjectRecord } from '../../files/types';
import type { ResolvedTheme, ThemeMode } from '../../nebula/ui/useTheme';
import { DAY_COLOURS, MAX_FADE, NIGHT_COLOURS, type BackdropMode } from '../backdrop';
import type { BackdropControls } from '../useBackdrop';
import { Button } from './Button';
import { handleRadioKeys, useEscapeLayer, useReturnFocus } from './hooks';
import { Icon } from './icons';
import { Swatches } from './Swatches';

export type SettingsTab = 'appearance' | 'project';

export type SettingsProps = {
  open: boolean;
  tab: SettingsTab;
  onTab: (tab: SettingsTab) => void;
  onClose: () => void;
  themeMode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  onThemeMode: (mode: ThemeMode) => void;
  /** The background of the theme on screen, and how to change it. */
  backdrop: BackdropControls;
  motion: boolean;
  onMotion: (on: boolean) => void;
  preferences: Preferences;
  onPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  projectCount: number;
  project: ProjectRecord | null;
  location: string;
  usage: string;
  fileCount: number;
  ephemeral: boolean;
  /** A folder project's folder, or null in the browser. */
  folderName?: string | null;
  /** A server project's server and its folder there. */
  serverPlace?: { label: string; folder: string } | null;
  /** Whether the browser has agreed to keep the files; null when it
   * doesn't say, undefined until it's asked. */
  kept?: boolean | null;
  /** When the open project was last downloaded from this browser ('Last downloaded today.'). */
  downloaded?: string | null;
  canDownload: boolean;
  /** False when the project list can't be changed (a registry from a newer
   * Nebula): name, colour and Remove show, turned off. Files still can. */
  canChangeProject?: boolean;
  onRename: (name: string) => void;
  onColour: (colour: string) => void;
  onDownload: () => void;
  onImport: () => void;
  onRemove: () => void;
  /** Move to a folder…, for a browser project where the browser can open
   * folders; absent otherwise. */
  onMoveToFolder?: () => void;
};

type Choice<T> = { value: T; label: string };

/** ss-ui's segmented radios, with arrow keys; the image converter uses them too. */
export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Choice<T>[]; onChange: (value: T) => void }) {
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) =>
        handleRadioKeys(
          event,
          options.map((option) => option.value),
          value,
          onChange,
        )
      }
    >
      {options.map((option) => (
        <Button
          key={option.value}
          className="segmented-option"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

const THEMES: Choice<ThemeMode>[] = [
  { value: 'dark', label: 'Night' },
  { value: 'light', label: 'Day' },
  { value: 'system', label: 'System' },
];

/** Settings: the app's ss-ui drawer, with Project (this project's name,
 * colour and files) and Appearance (this device's preferences). */
export function SettingsDrawer(props: SettingsProps) {
  const { open, tab, onTab, onClose } = props;
  const panel = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);

  useEscapeLayer(open, onClose);
  useReturnFocus(open, panel);

  // Slide in a frame after mounting, so the drawer's transition can play.
  useEffect(() => {
    if (!open) {
      setShown(false);
      return;
    }
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useLayoutEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [open]);

  if (!open) return null;

  const tabs: { id: SettingsTab; label: string }[] = [
    // Appearance, then Project (Bruce, 2026-10-25, back from 10-22's Project first).
    { id: 'appearance', label: 'Appearance' },
    { id: 'project', label: 'Project' },
  ];

  const onTabKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next = tab === 'appearance' ? 'project' : 'appearance';
    document.getElementById(`ws-settings-tab-${next}`)?.focus();
    onTab(next);
  };

  return (
    <>
      <div className={`drawer-backdrop${shown ? ' is-visible' : ''}`} aria-hidden="true" onClick={onClose} />
      <aside
        ref={panel}
        className={`drawer is-settings ws-settings${shown ? ' is-open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ws-settings-title"
      >
        <header className="drawer-header">
          <div className="drawer-title-block">
            <h2 className="drawer-title" id="ws-settings-title">
              Settings
            </h2>
          </div>
          <Button className="drawer-close" aria-label="Close settings" onClick={onClose}>
            ×
          </Button>
          <nav className="drawer-tabs" role="tablist" aria-label="Settings sections" onKeyDown={onTabKeys}>
            {tabs.map((entry) => (
              <Button
                key={entry.id}
                id={`ws-settings-tab-${entry.id}`}
                className="drawer-tab"
                role="tab"
                aria-selected={tab === entry.id}
                aria-controls={`ws-settings-panel-${entry.id}`}
                tabIndex={tab === entry.id ? 0 : -1}
                onClick={() => onTab(entry.id)}
              >
                {entry.label}
              </Button>
            ))}
          </nav>
        </header>
        <div className="drawer-inner">
          {tab === 'appearance' ? <Appearance {...props} /> : <ProjectPanel {...props} />}
        </div>
      </aside>
    </>
  );
}

const NIGHT_BACKGROUNDS: Choice<BackdropMode>[] = [
  { value: 'rich', label: 'Starfield' },
  { value: 'plain', label: 'Colour' },
  { value: 'image', label: 'Image' },
];

const DAY_BACKGROUNDS: Choice<BackdropMode>[] = [
  { value: 'rich', label: 'Parchment' },
  { value: 'plain', label: 'Colour' },
  { value: 'image', label: 'Image' },
];

/** The theme's background: the sky it comes with, a colour, or an image of
 * your own. Each choice shows its own settings under it. */
function Background(props: SettingsProps) {
  const { backdrop } = props;
  const night = props.resolvedTheme === 'dark';
  const options = (night ? NIGHT_BACKGROUNDS : DAY_BACKGROUNDS).filter((option) => option.value !== 'image' || backdrop.canUseImages);
  const mode = backdrop.value.mode === 'image' && !backdrop.canUseImages ? 'plain' : backdrop.value.mode;
  return (
    <div className="ws-set-row ws-bg">
      <span className="ws-set-label" aria-hidden="true">
        Background
      </span>
      <Segmented label={night ? 'Night background' : 'Day background'} value={mode} options={options} onChange={backdrop.setMode} />
      {mode === 'rich' && night ? (
        <div className="ws-bg-option">
          <label className="switch">
            <input type="checkbox" checked={props.motion} onChange={(event) => props.onMotion(event.target.checked)} />
            <span className="switch-track" aria-hidden="true" />
            <span className="switch-label">Animated background</span>
          </label>
          <p className="ws-set-help">Drifting stars and meteors. Off by default, because motion can distract while you draw.</p>
        </div>
      ) : null}
      {mode === 'plain' ? (
        <div className="ws-bg-option">
          <Swatches
            className="ws-swatches-row ws-swatches-flat"
            colours={night ? NIGHT_COLOURS : DAY_COLOURS}
            value={backdrop.value.colour}
            onChange={backdrop.setColour}
            label={night ? 'Night background colour' : 'Day background colour'}
          />
        </div>
      ) : null}
      {mode === 'image' ? <BackgroundImage {...props} /> : null}
      <p className="ws-set-help">Saved separately for night and day.</p>
    </div>
  );
}

/** An image of your own: a tile to choose or drop one, then its fade. */
function BackgroundImage({ backdrop, ephemeral }: SettingsProps) {
  const input = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  const shown = backdrop.imageUrl;
  const percent = Math.round(backdrop.value.fade * 100);
  const most = Math.round(MAX_FADE * 100);
  const pick = (files: FileList | null) => {
    const file = files?.[0];
    if (file) void backdrop.chooseImage(file);
  };
  const busy = backdrop.status === 'busy' || backdrop.status === 'loading';
  return (
    <div className="ws-bg-option ws-bg-image">
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          pick(event.target.files);
          event.target.value = '';
        }}
      />
      <Button
        className="ws-bg-tile"
        data-empty={shown ? undefined : ''}
        data-dropping={dropping ? '' : undefined}
        aria-label={shown ? 'Replace the background image' : 'Choose a background image'}
        aria-describedby="ws-bg-image-help"
        aria-busy={busy}
        style={shown ? ({ '--tile-image': `url("${shown}")`, '--tile-fade': String(backdrop.value.fade) } as CSSProperties) : undefined}
        onClick={() => input.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDropping(false);
          pick(event.dataTransfer.files);
        }}
      >
        {shown ? (
          <span className="ws-bg-tile-hint">Replace…</span>
        ) : (
          <>
            <Icon name="image" />
            <span>{busy ? 'Opening the image…' : 'Choose an image…'}</span>
            <small>or drop one here</small>
          </>
        )}
      </Button>
      {shown ? (
        <div className="ws-bg-controls">
          <label className="ws-bg-fade">
            <span aria-hidden="true">Fade</span>
            <input
              type="range"
              className="slider"
              aria-label="Fade"
              min={0}
              max={most}
              step={5}
              value={percent}
              aria-valuetext={`${percent}%`}
              style={{ '--value': (percent / most) * 100 } as CSSProperties}
              onChange={(event) => backdrop.setFade(Number(event.target.value) / 100)}
            />
            <output aria-hidden="true">{percent}%</output>
          </label>
          <Button className="ws-btn" onClick={() => void backdrop.removeImage()}>
            <Icon name="trash" />
            Remove
          </Button>
        </div>
      ) : null}
      {backdrop.problem ? (
        <p className="ws-set-help ws-bg-problem" role="alert">
          {backdrop.problem}
        </p>
      ) : null}
      <p className="ws-set-help" id="ws-bg-image-help">
        {ephemeral
          ? 'This browser can’t keep files here, so the image lasts until this tab closes.'
          : 'Kept in this browser, on this device. Large images are scaled down.'}
      </p>
    </div>
  );
}

function Appearance(props: SettingsProps) {
  const { preferences, onPreference } = props;
  const oneProject = props.projectCount < 2;
  return (
    <section role="tabpanel" id="ws-settings-panel-appearance" aria-labelledby="ws-settings-tab-appearance">
      <div className="drawer-section">
        <h3 className="ws-set-h">Theme</h3>
        <Segmented label="Theme" value={props.themeMode} options={THEMES} onChange={props.onThemeMode} />
        <Background {...props} />
      </div>

      <div className="drawer-section">
        <h3 className="ws-set-h">Workspace</h3>
        <div className="ws-set-row">
          <span className="ws-set-label" aria-hidden="true">
            Style
          </span>
          <div
            className="ws-cards"
            role="radiogroup"
            aria-label="Style"
            onKeyDown={(event) => handleRadioKeys(event, ['sheet', 'pane'] as const, preferences.style, (value) => onPreference('style', value))}
          >
            {(
              [
                { value: 'sheet', title: 'Sheet', text: 'Notes float on the sky' },
                { value: 'pane', title: 'Pane', text: 'Solid panes, like a classic editor' },
              ] as const
            ).map((card) => (
              <Button
                key={card.value}
                className="ws-card"
                role="radio"
                aria-checked={preferences.style === card.value}
                tabIndex={preferences.style === card.value ? 0 : -1}
                onClick={() => onPreference('style', card.value)}
              >
                <span className="ws-thumb" data-thumb={card.value} aria-hidden="true">
                  <i />
                  <i />
                </span>
                <b>{card.title}</b>
                <span>{card.text}</span>
              </Button>
            ))}
          </div>
        </div>
        <div className="ws-set-row" data-dock-row>
          <label className="switch">
            <input
              type="checkbox"
              checked={preferences.dock && !oneProject}
              disabled={oneProject}
              aria-describedby="ws-dock-help"
              onChange={(event) => onPreference('dock', event.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
            <span className="switch-label">Show projects in a dock</span>
          </label>
          <p className="ws-set-help" id="ws-dock-help">
            {oneProject ? 'Appears once you have a second project.' : 'Your projects as planets down the left edge.'}
          </p>
        </div>
      </div>

      <div className="drawer-section">
        <h3 className="ws-set-h">Notes</h3>
        <div className="ws-set-row">
          <span className="ws-set-label" aria-hidden="true">
            Page width
          </span>
          <Segmented
            label="Page width"
            value={preferences.width}
            options={[
              { value: 'fixed', label: 'Fixed' },
              { value: 'stretch', label: 'Stretch' },
            ]}
            onChange={(value) => onPreference('width', value)}
          />
          <p className="ws-set-help">Fixed keeps lines a comfortable length to read. Stretch fills the window.</p>
        </div>
        <div className="ws-set-row">
          <span className="ws-set-label" aria-hidden="true">
            Note text
          </span>
          <div
            className="ws-cards"
            role="radiogroup"
            aria-label="Note text"
            onKeyDown={(event) => handleRadioKeys(event, ['sans', 'serif'] as const, preferences.body, (value) => onPreference('body', value))}
          >
            {(
              [
                { value: 'sans', title: 'Mona Sans', text: 'Clean and even', serif: false },
                { value: 'serif', title: 'Newsreader', text: 'Bookish, for long reads', serif: true },
              ] as const
            ).map((card) => (
              <Button
                key={card.value}
                className="ws-card"
                role="radio"
                aria-checked={preferences.body === card.value}
                tabIndex={preferences.body === card.value ? 0 : -1}
                onClick={() => onPreference('body', card.value)}
              >
                <span className={card.serif ? 'ws-aa ws-aa-serif' : 'ws-aa'} aria-hidden="true">
                  Aa
                </span>
                <b>{card.title}</b>
                <span>{card.text}</span>
              </Button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function ProjectPanel(props: SettingsProps) {
  const { project } = props;
  const [name, setName] = useState(project?.name ?? '');
  const [seen, setSeen] = useState(project?.name);
  if (project?.name !== seen) {
    setSeen(project?.name);
    setName(project?.name ?? '');
  }

  if (!project) {
    return (
      <section role="tabpanel" id="ws-settings-panel-project" aria-labelledby="ws-settings-tab-project">
        <div className="drawer-section">
          <p className="ws-set-help">No project is open.</p>
        </div>
      </section>
    );
  }

  const commitName = () => {
    const next = name.trim();
    if (next && next !== project.name) props.onRename(next);
    else setName(project.name);
  };

  return (
    <section role="tabpanel" id="ws-settings-panel-project" aria-labelledby="ws-settings-tab-project">
      <div className="drawer-section">
        <h3 className="ws-set-h">Project</h3>
        <label className="ws-field">
          <span className="ws-set-label">Name</span>
          <input
            className="ws-input"
            type="text"
            value={name}
            disabled={props.canChangeProject === false}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setName(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitName();
              }
            }}
          />
        </label>
        <div className="ws-set-row">
          <span className="ws-set-label" aria-hidden="true">
            Colour
          </span>
          <Swatches className="ws-swatches-row" value={project.color} onChange={props.onColour} label="Colour" disabled={props.canChangeProject === false} />
        </div>
      </div>
      {props.serverPlace ? (
        <ServerFiles {...props} serverPlace={props.serverPlace} />
      ) : props.folderName ? (
        <FolderFiles {...props} folderName={props.folderName} />
      ) : (
        <BrowserFiles {...props} />
      )}
      {props.serverPlace ? (
        <div className="drawer-section">
          <h3 className="ws-set-h">Remove</h3>
          <p className="ws-set-help">{`${project.name} lives on ${props.serverPlace.label}. To remove it, remove its folder ‘${props.serverPlace.folder}’ there.`}</p>
        </div>
      ) : (
      <div className="drawer-section">
        <h3 className="ws-set-h">Remove</h3>
        <p className="ws-set-help">
          {props.folderName
            ? `Removes ${project.name} from Nebula. The folder ‘${props.folderName}’ and its files stay on this computer.`
            : `Deletes ${project.name} and its ${props.fileCount === 1 ? '1 file' : `${props.fileCount} files`} from ${props.ephemeral ? 'this tab' : 'this browser'}.`}
        </p>
        <div className="ws-set-actions">
          <Button className={props.folderName ? 'ws-btn' : 'ws-btn ws-btn-danger'} disabled={props.canChangeProject === false} onClick={props.onRemove}>
            <Icon name="trash" />
            {props.folderName ? 'Remove from Nebula…' : 'Remove project…'}
          </Button>
        </div>
      </div>
      )}
    </section>
  );
}

/** Download as .zip and Import, and when it was last downloaded. */
function FileActions(props: SettingsProps) {
  return (
    <>
      <div className="ws-set-actions">
        {props.canDownload ? (
          <Button className="ws-btn" onClick={props.onDownload}>
            <Icon name="download" />
            Download as .zip
          </Button>
        ) : null}
        <Button className="ws-btn" onClick={props.onImport}>
          <Icon name="upload" />
          Import files…
        </Button>
      </div>
      {props.canDownload && props.downloaded ? <p className="ws-set-help ws-set-downloaded">{props.downloaded}</p> : null}
    </>
  );
}

/** A folder project's files: ordinary files in a folder on this computer,
 * which the browser can't clear, backed up with the folder. */
function FolderFiles(props: SettingsProps & { folderName: string }) {
  return (
    <div className="drawer-section">
      <h3 className="ws-set-h">Files</h3>
      <div className="ws-where">
        <Icon name="folder" />
        <span>
          <b>In the folder ‘{props.folderName}’, on this computer</b>
          <span>{props.usage}</span>
        </span>
      </div>
      <FileActions {...props} />
      <p className="ws-set-help">
        These are ordinary files: other apps can open and change them, and Nebula shows their changes. Backing up the folder backs up the project, and a
        folder inside Dropbox, Google Drive, iCloud Drive, OneDrive or Proton Drive is backed up by that service’s own app.
      </p>
    </div>
  );
}

/** A server project's files: real files in a folder on a server,
 * which other people and agents with access to it can change too. */
function ServerFiles(props: SettingsProps & { serverPlace: { label: string; folder: string } }) {
  return (
    <div className="drawer-section">
      <h3 className="ws-set-h">Files</h3>
      <div className="ws-where">
        <Icon name="folder" />
        <span>
          <b>
            In the folder ‘{props.serverPlace.folder}’, on {props.serverPlace.label}
          </b>
          <span>{props.usage}</span>
        </span>
      </div>
      <FileActions {...props} />
      <p className="ws-set-help">
        These are ordinary files on {props.serverPlace.label}: agents and other apps there can change them, and Nebula shows their changes as they happen. They’re
        kept there, not in this browser: back them up where they are.
      </p>
    </div>
  );
}

/** A browser project's files, and what can clear them. */
function BrowserFiles(props: SettingsProps) {
  return (
    <div className="drawer-section">
      <h3 className="ws-set-h">Files</h3>
      <div className="ws-where">
        <Icon name="browser" />
        <span>
          <b>{props.location}</b>
          <span>
            {props.usage}
            {props.ephemeral ? ', gone when this tab closes' : ', on this device only'}
          </span>
        </span>
      </div>
      <FileActions {...props} />
      {props.onMoveToFolder ? (
        <>
          <div className="ws-set-actions">
            <Button className="ws-btn" onClick={props.onMoveToFolder}>
              <Icon name="folder" />
              Move to a folder…
            </Button>
          </div>
          <p className="ws-set-help">
            Move to a folder… copies its files into an empty folder on this computer, checks each one, and only then deletes the copy in this browser.
          </p>
        </>
      ) : null}
      {props.ephemeral ? (
        <p className="ws-set-help ws-set-warn">This browser can’t keep files here, so download anything you want to keep.</p>
      ) : props.kept === true ? (
        <p className="ws-set-help">
          This browser has agreed to keep Nebula’s files, even when space runs low. A .zip is still your copy if this device is lost or reset.
        </p>
      ) : props.kept === false ? (
        <p className="ws-set-help ws-set-warn">
          This browser may clear Nebula’s files when space runs low, and a private window forgets them when it closes. Safari can also clear them
          after a week of use without a visit. Keep a .zip of anything you’d miss, or install Nebula as an app (Help says how): browsers clear
          installed apps far less often.
        </p>
      ) : props.kept === null ? (
        <p className="ws-set-help ws-set-warn">
          This browser doesn’t say whether it keeps Nebula’s files, and a private window forgets them when it closes. Keep a .zip of anything
          you’d miss, or install Nebula as an app (Help says how): browsers clear installed apps far less often.
        </p>
      ) : null}
    </div>
  );
}
