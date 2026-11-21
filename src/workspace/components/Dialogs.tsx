import { FOLDERS_NEED_CHROMIUM } from '../folders';
import { useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { NEBULA_LOGO_SRC } from '../../nebula/ui/logo';
import { Button, Planet } from './Button';
import { handleRadioKeys } from './hooks';
import { Icon } from './icons';
import { Swatches } from './Swatches';

/** Major and minor of the build's version ("2.0"), from package.json (vite.config.ts define). */
const NEBULA_VERSION = typeof __NEBULA_VERSION__ === 'string' ? __NEBULA_VERSION__.split('.').slice(0, 2).join('.') : '';

type WsDialogProps = {
  open: boolean;
  onClose: () => void;
  className?: string;
  labelledBy?: string;
  /** The control to focus when the dialog opens: its main action or field. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Skip ss-ui's .dialog shell (quick open has its own). */
  bare?: boolean;
  label?: string;
  children: ReactNode;
};

/** ss-ui's native <dialog> shell, opened with showModal() so focus stays
 * inside and the page behind is inert. Escape and a press on the backdrop
 * close it; focus goes back where it was. */
export function WsDialog({ open, onClose, className, labelledBy, initialFocus, bare, label, children }: WsDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    if (!dialog.open) {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    const target = initialFocus?.current;
    if (target) target.focus();
    return () => {
      if (dialog.open) {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
      }
      const back = returnTo.current;
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, [open, initialFocus]);

  return (
    <dialog
      ref={ref}
      className={[bare ? '' : 'dialog ws-dialog', className ?? ''].filter(Boolean).join(' ')}
      aria-labelledby={labelledBy || undefined}
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      {open ? children : null}
    </dialog>
  );
}

/* ------------------------------------------------------------------ */

/** Files listed under the confirm dialog's paragraph (the delete dialog's
 * “Referenced by”): a short list, then how many more, so a file a hundred
 * notes link to keeps the dialog the size it always is. */
export type ConfirmList = {
  heading: string;
  items: { key: string; name: string; /** Where it is, shown quietly: its folder. */ where?: string; /** What it is, when that matters: “canvas”. */ kind?: string }[];
  more: number;
};

type ConfirmProps = {
  open: boolean;
  title: string;
  body: ReactNode;
  list?: ConfirmList;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({ open, title, body, list, confirmLabel, danger, onConfirm, onCancel }: ConfirmProps) {
  const id = useId();
  const listId = useId();
  const confirm = useRef<HTMLButtonElement>(null);
  return (
    <WsDialog open={open} onClose={onCancel} className="ws-small ws-confirm" labelledBy={id} initialFocus={confirm}>
      <div className="ws-small-inner">
        <h2 id={id}>{title}</h2>
        <p>{body}</p>
        {list && list.items.length > 0 ? (
          <section className="ws-confirm-list" aria-labelledby={listId}>
            <h3 id={listId}>{list.heading}</h3>
            <ul>
              {list.items.map((item) => (
                <li key={item.key}>
                  <span className="ws-confirm-list-name">{item.name}</span>
                  {item.kind ? <span className="ws-confirm-list-quiet">{item.kind}</span> : null}
                  {item.where ? <span className="ws-confirm-list-quiet">{item.where}</span> : null}
                </li>
              ))}
            </ul>
            {list.more > 0 ? <p className="ws-confirm-list-more">and {list.more} more</p> : null}
          </section>
        ) : null}
        <footer className="ws-dialog-foot">
          <Button className="ws-btn-quiet" onClick={onCancel}>
            Cancel
          </Button>
          <Button ref={confirm} className="welcome-dialog-cta" data-danger={danger ? '' : undefined} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </footer>
      </div>
    </WsDialog>
  );
}

/* ------------------------------------------------------------------ */

type PromptProps = {
  open: boolean;
  title: string;
  label: string;
  initialValue: string;
  confirmLabel: string;
  validate?: (value: string) => string | null;
  onSubmit: (value: string) => void;
  onCancel: () => void;
};

export function PromptDialog(props: PromptProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  return (
    <WsDialog open={props.open} onClose={props.onCancel} className="ws-small ws-prompt" labelledBy={id} initialFocus={input}>
      <PromptBody {...props} titleId={id} inputRef={input} />
    </WsDialog>
  );
}

function PromptBody({
  title,
  label,
  initialValue,
  confirmLabel,
  validate,
  onSubmit,
  onCancel,
  titleId,
  inputRef,
}: PromptProps & { titleId: string; inputRef: RefObject<HTMLInputElement | null> }) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  useLayoutEffect(() => {
    inputRef.current?.select();
  }, [inputRef]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problem = validate?.(value) ?? (value.trim() ? null : 'Give it a name.');
    if (problem) {
      setError(problem);
      inputRef.current?.focus();
      return;
    }
    onSubmit(value.trim());
  };

  return (
    <form className="ws-small-inner" onSubmit={submit} noValidate>
      <h2 id={titleId}>{title}</h2>
      <label className="ws-field">
        <span className="ws-set-label">{label}</span>
        <input
          ref={inputRef}
          className="ws-input"
          type="text"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      {error ? (
        <p className="ws-field-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
      <footer className="ws-dialog-foot">
        <Button className="ws-btn-quiet" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" className="welcome-dialog-cta">
          {confirmLabel}
        </Button>
      </footer>
    </form>
  );
}

/* ------------------------------------------------------------------ */

type NewProjectProps = {
  open: boolean;
  /** False when this browser keeps nothing: the dialog says so, as the
   * welcome does. */
  persistent: boolean;
  initialColour: string;
  /** The name it suggests, and takes when none is typed. */
  defaultName?: string;
  /** This browser can keep a project in a folder on this computer:
   * the dialog asks where its files live. */
  canUseFolders?: boolean;
  /** Where it may go, as the page's host offers (src/files/places.ts): this
   * browser, a folder (with canUseFolders) and the server that served the
   * page. When not given, this browser and, with canUseFolders, a folder. */
  homes?: ProjectHome[];
  /** What the server calls itself, for its choice and its note. */
  serverLabel?: string;
  /** Waiting for the server to make it. */
  busy?: boolean;
  /** Why it couldn't be made, said in the dialog. */
  error?: string | null;
  onCreate: (input: { name: string; color: string; where: ProjectHome }) => void;
  onCancel: () => void;
};

/** Where a new project's files live. */
export type ProjectHome = 'browser' | 'folder' | 'server';

function homeLabel(home: ProjectHome, serverLabel: string): string {
  return home === 'browser' ? 'In this browser' : home === 'folder' ? 'In a folder on this computer' : `On ${serverLabel}`;
}

/** New project: the planet takes shape as you name and colour it. Its files
 * stay in this browser, go in a folder on this computer that the person
 * picks next (where the browser can), or are made on the server that served
 * the page (where it makes projects). */
export function NewProjectDialog({ open, persistent, initialColour, defaultName, canUseFolders, homes, serverLabel, busy, error, onCreate, onCancel }: NewProjectProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  return (
    <WsDialog open={open} onClose={onCancel} className="ws-np" labelledBy={id} initialFocus={input}>
      <NewProjectBody
        titleId={id}
        inputRef={input}
        persistent={persistent}
        initialColour={initialColour}
        defaultName={defaultName}
        canUseFolders={canUseFolders}
        homes={homes}
        serverLabel={serverLabel}
        busy={busy}
        error={error}
        onCreate={onCreate}
        onCancel={onCancel}
      />
    </WsDialog>
  );
}

function NewProjectBody({
  titleId,
  inputRef,
  persistent,
  initialColour,
  defaultName = 'Untitled project',
  canUseFolders = false,
  homes,
  serverLabel = 'the server',
  busy = false,
  error = null,
  onCreate,
  onCancel,
}: Omit<NewProjectProps, 'open'> & { titleId: string; inputRef: RefObject<HTMLInputElement | null> }) {
  const [name, setName] = useState('');
  const [colour, setColour] = useState(initialColour);
  const choices: ProjectHome[] = homes ?? (canUseFolders ? ['browser', 'folder'] : ['browser']);
  const [home, setHome] = useState<ProjectHome>(choices[0] ?? 'browser');
  const shown = name.trim() || defaultName;
  const where: ProjectHome = choices.includes(home) ? home : (choices[0] ?? 'browser');
  const inFolder = where === 'folder';
  const onServer = where === 'server';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    // Straight from the click: a folder picker needs it.
    onCreate({ name: shown, color: colour, where });
  };

  return (
    <form className="ws-np-inner" onSubmit={submit} noValidate>
      <header className="ws-np-head">
        <h2 id={titleId}>New project</h2>
        <Button className="ws-icon-btn" aria-label="Close" onClick={onCancel}>
          <Icon name="close" />
        </Button>
      </header>
      <div className="ws-np-top">
        <div className="ws-np-preview" aria-hidden="true">
          <Planet color={colour} className="ws-np-planet" />
          <span className="ws-np-name">{shown}</span>
        </div>
        <div className="ws-np-fields">
          <label className="ws-field">
            <span className="ws-set-label">Name</span>
            <input
              ref={inputRef}
              className="ws-input"
              type="text"
              value={name}
              placeholder={defaultName}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="ws-field">
            <span className="ws-set-label" aria-hidden="true">
              Colour
            </span>
            <Swatches value={colour} onChange={setColour} label="Colour" />
          </div>
          {choices.length > 1 ? (
            <div className="ws-field">
              <span className="ws-set-label" aria-hidden="true">
                Where
              </span>
              <div
                className="segmented ws-np-where"
                role="radiogroup"
                aria-label="Where its files live"
                onKeyDown={(event) =>
                  handleRadioKeys(
                    event,
                    choices,
                    where,
                    setHome,
                  )
                }
              >
                {choices.map((option) => (
                  <Button
                    key={option}
                    className="segmented-option"
                    role="radio"
                    aria-checked={option === where}
                    tabIndex={option === where ? 0 : -1}
                    onClick={() => setHome(option)}
                  >
                    {homeLabel(option, serverLabel)}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
          <p className="ws-np-note">
            {inFolder
              ? 'You’ll choose the folder next. Files already in it open as they are, with Nebula’s own settings in a .nebula folder beside them. Other apps can open them too.'
              : onServer
                ? `Its files are kept by ${serverLabel}, not in this browser.`
                : persistent
                  ? `Its files are saved in this browser, on this device.${canUseFolders ? '' : ` ${FOLDERS_NEED_CHROMIUM}`}`
                  : 'This browser can’t keep files here, so its files last until you close this tab.'}
          </p>
          {error ? (
            <p className="ws-set-help ws-set-warn" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>
      <footer className="ws-dialog-foot ws-np-foot">
        <Button className="ws-btn-quiet" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" className="welcome-dialog-cta" disabled={busy}>
          {inFolder ? 'Choose folder…' : busy ? 'Creating…' : 'Create project'}
        </Button>
      </footer>
    </form>
  );
}

/* ------------------------------------------------------------------ */

type IntroProps = {
  open: boolean;
  persistent: boolean;
  /** Only the host's server keeps projects here (its name): the welcome
   * offers to start one there, with no sample. */
  keptBy?: string | null;
  projectName: string;
  canDownload: boolean;
  onExplore: () => void;
  onStartEmpty: () => void;
};

/** The welcome (Orbit's dialog shell), for brand-new visitors, over the
 * sample project. It describes only what has shipped. */
export function IntroDialog({ open, persistent, keptBy = null, projectName, canDownload, onExplore, onStartEmpty }: IntroProps) {
  const id = useId();
  const main = useRef<HTMLButtonElement>(null);
  const keep = keptBy
    ? `Projects you start here are kept by ${keptBy}, not in this browser.`
    : persistent
    ? `Projects you start here are saved in this browser, on this device, and nowhere else.${canDownload ? ' Browsers can clear what websites keep, so download a project as a .zip to keep a copy.' : ''}`
    : `This browser can’t keep files here, so projects last until you close this tab.${canDownload ? ' Download a project as a .zip to keep it.' : ''}`;

  const notices: { label: string; text: string }[] = [
    { label: 'Your files', text: keep },
    { label: 'Drawings', text: 'Canvases are Excalidraw drawings. Export them for Excalidraw or Obsidian.' },
    ...(keptBy ? [] : [{ label: 'Sample', text: `${projectName} is a small sample project. Explore it, then delete it whenever you like.` }]),
  ];

  return (
    <WsDialog open={open} onClose={onExplore} className="ws-welcome" labelledBy={id} initialFocus={main}>
      <div className="welcome-dialog-inner">
        <div className="welcome-dialog-head">
          <img className="welcome-dialog-logo" src={NEBULA_LOGO_SRC} alt="" />
          {/* Nebula is more than its canvases now: the pill names the version. */}
          {NEBULA_VERSION ? <span className="welcome-dialog-edition-pill">Version {NEBULA_VERSION}</span> : null}
        </div>
        <div>
          <h2 id={id} className="welcome-dialog-title">
            Starscape Nebula
          </h2>
          <p className="welcome-dialog-lede">
            {keptBy ? 'Notes, drawings and media, together in projects.' : 'Notes, drawings and media, together in projects. Nebula runs in your browser, with no account.'}
          </p>
        </div>
        <ul className="welcome-dialog-notices">
          {notices.map((notice) => (
            <li key={notice.label}>
              <span className="welcome-dialog-notice-label">{notice.label}</span>
              {notice.text}
            </li>
          ))}
        </ul>
        <footer className="welcome-dialog-footer ws-dialog-foot">
          {keptBy ? (
            <>
              <Button className="ws-btn-quiet" onClick={onExplore}>
                Not now
              </Button>
              <Button ref={main} className="welcome-dialog-cta" onClick={onStartEmpty}>
                Start a project
              </Button>
            </>
          ) : (
            <>
              <Button className="ws-btn-quiet" onClick={onStartEmpty}>
                Start empty
              </Button>
              <Button ref={main} className="welcome-dialog-cta" onClick={onExplore}>
                Explore the sample
              </Button>
            </>
          )}
        </footer>
      </div>
    </WsDialog>
  );
}
