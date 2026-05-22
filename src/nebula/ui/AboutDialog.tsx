import { useEffect, useRef } from 'react';
import { Dialog } from '@starlove/ui-react';
import { NEBULA_LOGO_SRC } from './logo';

type AboutDialogProps = {
  open: boolean;
  onClose: () => void;
};

type Step = { title: string; meta: string; body: string };

const STEPS: Step[] = [
  {
    title: 'Pick or create a canvas',
    meta: 'Boards',
    body: 'Use the board dropdown or “New Canvas”. Each canvas is saved locally in your browser, per board — nothing leaves your machine.',
  },
  {
    title: 'Draw with Excalidraw',
    meta: 'Toolbar',
    body: 'Sketch shapes, arrows, text, and freehand with the Excalidraw toolbar. Everything is hand-drawn-style and stays fully editable.',
  },
  {
    title: 'Set the mood',
    meta: 'Settings',
    body: 'Switch light/dark and choose a background flavor (starfield/parchment or plain) in Settings. Turn on the animated background if you like motion.',
  },
  {
    title: 'Back up your work',
    meta: 'Repository',
    body: 'Export the current canvas as an .excalidraw file from Settings → Repository, and re-import it any time.',
  },
];

type Shortcut = { keys: string[]; label: string };

const SHORTCUTS: Shortcut[] = [
  { keys: ['V'], label: 'Select' },
  { keys: ['R'], label: 'Rectangle' },
  { keys: ['O'], label: 'Ellipse' },
  { keys: ['A'], label: 'Arrow' },
  { keys: ['L'], label: 'Line' },
  { keys: ['P'], label: 'Draw' },
  { keys: ['T'], label: 'Text' },
  { keys: ['Space', 'drag'], label: 'Pan' },
  { keys: ['⌘', 'scroll'], label: 'Zoom' },
  { keys: ['⌘', 'Z'], label: 'Undo' },
  { keys: ['⌘', 'D'], label: 'Duplicate' },
  { keys: ['Del'], label: 'Delete' },
  { keys: ['Esc'], label: 'Deselect' },
];

/**
 * Centered "About / Help" dialog for Nebula — what the app is, how to get
 * started, and the key Excalidraw shortcuts. Styled to match ss-orbit's
 * welcome dialog (.orbit-dialog); rendered as a native <dialog> so Escape,
 * backdrop, and focus-trap come for free.
 */
export function AboutDialog({ open, onClose }: AboutDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  // The package <Dialog> owns showModal/close, Escape, and backdrop-click. We
  // keep a ref only to reset the scroll to the top on open — <dialog>
  // autofocuses its first focusable element (the close button), so the header
  // stays in view.
  useEffect(() => {
    if (open && ref.current) ref.current.scrollTop = 0;
  }, [open]);

  return (
    <Dialog
      ref={ref}
      open={open}
      onClose={onClose}
      className="nebula-about"
      aria-labelledby="nebula-about-title"
    >
      <div className="nebula-about__inner">
        <header className="nebula-about__head">
          <img className="nebula-about__logo" src={NEBULA_LOGO_SRC} alt="" aria-hidden="true" />
          <span className="nebula-about__pill">Powered by Excalidraw</span>
          <button
            type="button"
            className="nebula-about__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="nebula-about__body">
          <h2 id="nebula-about-title" className="nebula-about__title">
            Starscape Nebula
          </h2>
          <p className="nebula-about__lede">
            An infinite Excalidraw canvas wrapped in the Starscape shell. Sketch, diagram, and
            design freely — your scenes are saved locally in the browser, per board and canvas.
          </p>

          <section className="nebula-about__section" aria-label="Getting started">
            <h3 className="nebula-about__heading">Getting started</h3>
            <ol className="nebula-about-steps">
              {STEPS.map((step, index) => (
                <li key={step.title} className="nebula-about-step">
                  <span className="nebula-about-step__index">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div>
                    <header className="nebula-about-step__header">
                      <h4>{step.title}</h4>
                      <span>{step.meta}</span>
                    </header>
                    <p>{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section className="nebula-about__section" aria-label="Keyboard shortcuts">
            <h3 className="nebula-about__heading">Keyboard shortcuts</h3>
            <ul className="nebula-about-keys">
              {SHORTCUTS.map((shortcut) => (
                <li key={shortcut.label} className="nebula-about-key">
                  <span className="nebula-about-key__combo">
                    {shortcut.keys.map((key, i) => (
                      <kbd key={i}>{key}</kbd>
                    ))}
                  </span>
                  <span className="nebula-about-key__label">{shortcut.label}</span>
                </li>
              ))}
            </ul>
            <p className="nebula-about__note">
              Open Excalidraw’s built-in help (the “?” on the canvas) for the full list.
            </p>
          </section>
        </div>

        <footer className="nebula-about__footer">
          <button type="button" className="nebula-about__cta" onClick={onClose}>
            Got it
          </button>
        </footer>
      </div>
    </Dialog>
  );
}

export default AboutDialog;
