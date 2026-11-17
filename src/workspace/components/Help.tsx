import { FOLDERS_NEED_CHROMIUM } from '../folders';
import { useId, useRef } from 'react';
import { NEBULA_LOGO_SRC } from '../../nebula/ui/logo';
import { Button } from './Button';
import { WsDialog } from './Dialogs';
import { isApple } from './ui';

type HelpProps = {
  open: boolean;
  /** Whether this browser keeps Nebula's files (false: they last as long as the tab). */
  persistent: boolean;
  /** Whether Settings can download a project as a .zip. */
  canDownload: boolean;
  /** Whether this browser can keep a project in a folder on this computer: said only where it can, so no one is told of what they can't use. */
  canUseFolders?: boolean;
  onClose: () => void;
};

type Step = { title: string; meta: string; body: string };

const STEPS: Step[] = [
  {
    title: 'Projects',
    meta: 'Project menu',
    body: 'Each project has its own files. Switch projects, or start a new one, from the name at the top of the sidebar.',
  },
  {
    title: 'Files',
    meta: 'Sidebar',
    body: 'Make a note or a canvas with the buttons above your files, or drop files from your computer onto them. Drag a file onto a folder to move it.',
  },
  {
    title: 'Tabs',
    meta: 'Side by side',
    body: 'Files open side by side in tabs. Star the ones you come back to, and they wait at the top of the sidebar.',
  },
  {
    title: 'Canvases',
    meta: 'Excalidraw',
    body: 'Canvases are Excalidraw drawings. Export them for Excalidraw or Obsidian.',
  },
  {
    title: 'Images',
    meta: 'Right-click',
    body: 'Right-click an image, or a folder of them, to turn it into WebP, JPEG or PNG, or make it smaller. It all happens on this device.',
  },
  {
    title: 'Agent sessions',
    meta: 'Paste as note',
    body: 'Copied a reply from an agent? Right-click a folder and choose Paste as note: it’s saved as Markdown, named for when you pasted it.',
  },
  {
    title: 'Links',
    meta: 'Copy link',
    body: 'Right-click a file or folder and choose Copy link, for an Orbit card or a note. It opens in this browser, where the project is.',
  },
];

/** Where the files live, said plainly, then how to keep them: the thing a
 * person most needs to know about a workspace that lives in their browser. */
function whereLines(persistent: boolean, canDownload: boolean, canUseFolders: boolean): string[] {
  const download = 'Settings → Project → Download as .zip';
  if (!persistent) {
    return [
      `This browser can’t keep files for Nebula, so they last until you close this tab.${canDownload ? ` Download a project to keep it: ${download}.` : ''}`,
    ];
  }
  return [
    'In this browser, on this device. Nothing is uploaded, and there’s no account.',
    `Another browser, another device or a private window doesn’t see them.${canDownload ? ' To move a project, download it as a .zip and import its files there.' : ''}`,
    `Browsers can clear what websites keep: when the disk runs low, or, in Safari, after a week of use without a visit.${canDownload ? ` Keep a copy of anything you’d miss: ${download}.` : ''}`,
    'Browsers clear installed apps far less often. To install Nebula: in Chrome or Edge, Install in the address bar or the menu; in Safari on a Mac, File → Add to Dock; on iPhone or iPad, Share → Add to Home Screen.',
    ...(canUseFolders
      ? [
          'This browser can also keep a project in a folder on your computer: New project → In a folder on this computer, or Open a folder… in the project menu. Its files are then ordinary files other apps can open, which the browser can’t clear, and a folder inside Dropbox, Google Drive, iCloud Drive, OneDrive or Proton Drive is backed up by that service’s own app.',
        ]
      : [FOLDERS_NEED_CHROMIUM]),
  ];
}

/** The workspace's Help: where your files live, getting started, and the
 * keys. (The 1.x canvas shell keeps its own, src/nebula/ui/AboutDialog.) */
export function Help({ open, persistent, canDownload, canUseFolders = false, onClose }: HelpProps) {
  const id = useId();
  // Focus starts on Close, at the top, so Help opens on where the files live
  // (focus on Got it would scroll a tall Help to its end).
  const close = useRef<HTMLButtonElement>(null);
  const mod = isApple() ? '⌘' : 'Ctrl';
  const keys: { keys: string[]; label: string }[] = [
    { keys: [mod, 'K'], label: 'Search notes and canvases, or jump to a file' },
    { keys: [mod, '\\'], label: 'Show or hide the sidebar' },
    { keys: [mod, 'E'], label: 'Edit or read a note' },
    { keys: [mod, 'Shift', 'E'], label: 'Live preview or the Markdown source, while editing' },
    { keys: ['F2'], label: 'Rename a file' },
    { keys: ['Delete'], label: 'Delete a file' },
    { keys: ['Shift', 'F10'], label: 'Open a file’s menu' },
  ];

  return (
    <WsDialog open={open} onClose={onClose} className="ws-help nebula-about" labelledBy={id} initialFocus={close}>
      <div className="nebula-about__inner">
        <header className="nebula-about__head">
          <img className="nebula-about__logo" src={NEBULA_LOGO_SRC} alt="" aria-hidden="true" />
          <button ref={close} type="button" className="nebula-about__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="nebula-about__body">
          <div>
            <h2 id={id} className="nebula-about__title">
              Starscape Nebula
            </h2>
            <p className="nebula-about__lede">Your project’s files in one place: notes, canvases, images, PDFs and more, open side by side in tabs.</p>
          </div>

          <section className="nebula-about__section" aria-labelledby={`${id}-where`}>
            <h3 id={`${id}-where`} className="nebula-about__heading">
              Where your files live
            </h3>
            <ul className="ws-help-where">
              {whereLines(persistent, canDownload, canUseFolders).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>

          <section className="nebula-about__section" aria-labelledby={`${id}-start`}>
            <h3 id={`${id}-start`} className="nebula-about__heading">
              Getting started
            </h3>
            <ol className="nebula-about-steps">
              {STEPS.map((step, index) => (
                <li key={step.title} className="nebula-about-step">
                  <span className="nebula-about-step__index">{String(index + 1).padStart(2, '0')}</span>
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

          <section className="nebula-about__section" aria-labelledby={`${id}-keys`}>
            <h3 id={`${id}-keys`} className="nebula-about__heading">
              Keyboard
            </h3>
            <ul className="nebula-about-keys">
              {keys.map((shortcut) => (
                <li key={shortcut.label} className="nebula-about-key">
                  <span className="nebula-about-key__combo">
                    {shortcut.keys.map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </span>
                  <span className="nebula-about-key__label">{shortcut.label}</span>
                </li>
              ))}
            </ul>
            <p className="nebula-about__note">On a canvas, press ? for Excalidraw’s own shortcuts.</p>
          </section>

          <p className="nebula-about__note ws-help-legal">
            Nebula is open source under the GNU AGPL-3.0, © 2026 Starscape LLC. It’s built with open-source libraries,{' '}
            <a href={`${import.meta.env.BASE_URL}third-party-licenses.txt`} target="_blank" rel="noopener">
              listed here with their licences
            </a>
            . Our{' '}
            <a href="https://starscape.biz/privacy/#apps" target="_blank" rel="noopener">
              privacy page
            </a>{' '}
            says what Nebula keeps, and where.
          </p>
        </div>

        <footer className="nebula-about__footer">
          <Button className="welcome-dialog-cta" onClick={onClose}>
            Got it
          </Button>
        </footer>
      </div>
    </WsDialog>
  );
}
