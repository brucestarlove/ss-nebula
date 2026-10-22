import { useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { NEBULA_LOGO_SRC } from '../../nebula/ui/logo';
import { Button, Planet } from './Button';
import { Icon } from './icons';
import { Swatches } from './Swatches';

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

type ConfirmProps = {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({ open, title, body, confirmLabel, danger, onConfirm, onCancel }: ConfirmProps) {
  const id = useId();
  const confirm = useRef<HTMLButtonElement>(null);
  return (
    <WsDialog open={open} onClose={onCancel} className="ws-small ws-confirm" labelledBy={id} initialFocus={confirm}>
      <div className="ws-small-inner">
        <h2 id={id}>{title}</h2>
        <p>{body}</p>
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
   * welcome does (review finding 7). */
  persistent: boolean;
  initialColour: string;
  /** The name it suggests, and takes when none is typed. */
  defaultName?: string;
  onCreate: (input: { name: string; color: string }) => void;
  onCancel: () => void;
};

/** New project: the planet takes shape as you name and colour it. Its files
 * stay in this browser (docs/slice-3.md, decision 6: no storage choice yet). */
export function NewProjectDialog({ open, persistent, initialColour, defaultName, onCreate, onCancel }: NewProjectProps) {
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
  onCreate,
  onCancel,
}: Omit<NewProjectProps, 'open'> & { titleId: string; inputRef: RefObject<HTMLInputElement | null> }) {
  const [name, setName] = useState('');
  const [colour, setColour] = useState(initialColour);
  const shown = name.trim() || defaultName;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onCreate({ name: shown, color: colour });
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
          <p className="ws-np-note">
            {persistent
              ? 'Its files are saved in this browser, on this device.'
              : 'This browser can’t keep files here, so its files last until you close this tab.'}
          </p>
        </div>
      </div>
      <footer className="ws-dialog-foot ws-np-foot">
        <Button className="ws-btn-quiet" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" className="welcome-dialog-cta">
          Create project
        </Button>
      </footer>
    </form>
  );
}

/* ------------------------------------------------------------------ */

/** What a move of 1.x canvases didn't do (re-review R3): canvases that
 * stayed in localStorage, and its other warnings. */
export type MigrationLeftBehind = {
  canvases: Array<{ key: string; name: string }>;
  warnings: string[];
};

type IntroProps = {
  variant: 'welcome' | 'migrated';
  /** For 'migrated': what didn't move. Null or absent when everything did. */
  leftBehind?: MigrationLeftBehind | null;
  /** Downloads a canvas that stayed behind as an .excalidraw file. */
  onDownloadLeftBehind?: (key: string) => void;
  open: boolean;
  persistent: boolean;
  projectName: string;
  canDownload: boolean;
  onExplore: () => void;
  onStartEmpty: () => void;
};

/** The welcome (Orbit's dialog shell), for brand-new visitors, over the
 * sample project; and the one-time note for people whose canvases moved in.
 * It describes only what has shipped (PLAN §8.3). */
export function IntroDialog({ variant, open, persistent, projectName, canDownload, onExplore, onStartEmpty, leftBehind, onDownloadLeftBehind }: IntroProps) {
  const id = useId();
  const main = useRef<HTMLButtonElement>(null);
  const keep = persistent
    ? `Projects you start here are saved in this browser, on this device.${canDownload ? ' Download any project as a .zip.' : ''}`
    : `This browser can’t keep files here, so projects last until you close this tab.${canDownload ? ' Download a project as a .zip to keep it.' : ''}`;

  const stayed = leftBehind?.canvases ?? [];
  const warnings = leftBehind?.warnings ?? [];
  const one = stayed.length === 1;
  const notices: { label: string; text: string; more?: ReactNode }[] =
    variant === 'welcome'
      ? [
          { label: 'Your files', text: keep },
          { label: 'Drawings', text: 'Canvases are Excalidraw drawings. Export them for Excalidraw or Obsidian.' },
          { label: 'Sample', text: `${projectName} is a small sample project. Explore it, then delete it whenever you like.` },
        ]
      : [
          {
            label: 'Your canvases',
            text: `Each board you had is now a project, and each canvas${stayed.length ? ' that moved' : ''} is a file in it, saved in this browser on this device.`,
          },
          // Said only when it's true (re-review R3); otherwise what wasn't.
          ...(stayed.length === 0 && warnings.length === 0 ? [{ label: 'Nothing lost', text: 'Nebula copied them. The originals stay where they were.' }] : []),
          ...(stayed.length
            ? [
                {
                  label: 'Not moved',
                  text: `${one ? '1 canvas' : `${stayed.length} canvases`} couldn’t be moved, so ${one ? 'it stays' : 'they stay'} in this browser where Nebula 1.x kept ${one ? 'it' : 'them'}. Download ${one ? 'it' : 'each'} as an .excalidraw file to upload into a project.`,
                  more: (
                    <ul className="ws-left-behind">
                      {stayed.map((canvas) => (
                        <li key={canvas.key}>
                          <span>{canvas.name}</span>
                          {onDownloadLeftBehind ? (
                            <Button className="ws-btn" aria-label={`Download “${canvas.name}” as .excalidraw`} onClick={() => onDownloadLeftBehind(canvas.key)}>
                              Download
                            </Button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ),
                },
              ]
            : []),
          ...(warnings.length ? [{ label: 'Also', text: warnings.join(' ') }] : []),
          { label: 'Drawings', text: 'Canvases are Excalidraw drawings. Export them for Excalidraw or Obsidian.' },
        ];

  return (
    <WsDialog open={open} onClose={onExplore} className="ws-welcome" labelledBy={id} initialFocus={main}>
      <div className="welcome-dialog-inner">
        <div className="welcome-dialog-head">
          <img className="welcome-dialog-logo" src={NEBULA_LOGO_SRC} alt="" />
          <span className="welcome-dialog-edition-pill">Powered by Excalidraw</span>
        </div>
        <div>
          <h2 id={id} className="welcome-dialog-title">
            Starscape Nebula
          </h2>
          <p className="welcome-dialog-lede">
            {variant === 'welcome'
              ? 'Notes, drawings and media, together in projects. Nebula runs in your browser, with no account.'
              : 'Your canvases are now files in projects.'}
          </p>
        </div>
        <ul className="welcome-dialog-notices">
          {notices.map((notice) => (
            <li key={notice.label}>
              <span className="welcome-dialog-notice-label">{notice.label}</span>
              {notice.text}
              {notice.more}
            </li>
          ))}
        </ul>
        <footer className="welcome-dialog-footer ws-dialog-foot">
          {variant === 'welcome' ? (
            <>
              <Button className="ws-btn-quiet" onClick={onStartEmpty}>
                Start empty
              </Button>
              <Button ref={main} className="welcome-dialog-cta" onClick={onExplore}>
                Explore the sample
              </Button>
            </>
          ) : (
            <Button ref={main} className="welcome-dialog-cta" onClick={onExplore}>
              Got it
            </Button>
          )}
        </footer>
      </div>
    </WsDialog>
  );
}
