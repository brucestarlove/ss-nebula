/**
 * The app's side of the frame (docs/hosting.md, "In a frame"): the messages between a host that
 * frames Nebula (the Suite's shell) and the app, typed in src/files/serverContract.ts. This file
 * sends to the host; what the app does on each message the host sends comes with it (below).
 *
 * Both directions stay inside one origin: the app listens only to its own parent window, on its
 * own origin, and sends only to that window with its own origin as the target. A page that isn't
 * framed listens to no one and sends nothing. Pausing the live feed of a tab hidden for a while
 * is the app's own business and runs framed or not.
 */
import { pauseFeeds, resumeFeeds, retryAccounts } from '../files/account';
import { isContextLink } from '../files/contextLink';
import type { AppMessage, HostMessage } from '../files/serverContract';
import { appHome, appMount } from './routes';

/** Whether this page is inside another page's frame. A page that isn't talks to no one. */
export function isFramed(win: Pick<Window, 'parent'> = window): boolean {
  try {
    return win.parent !== (win as unknown as Window);
  } catch {
    return false;
  }
}

/** Tells the host something; false (and nothing sent) when there is no host to tell. */
export function sendToHost(message: AppMessage, win: Window = window): boolean {
  if (!isFramed(win)) return false;
  try {
    win.parent.postMessage(message, win.location.origin);
    return true;
  } catch {
    return false;
  }
}

/** A web address a host or server gave, as an absolute one, or null when it isn't http(s): a link
 * from the network never becomes `javascript:` in a button. */
export function safeLink(href: string | undefined | null, base: string = window.location.href): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** "Sign in again". In a frame, the host does it (`sign-in`; the app keeps unsaved edits). Alone,
 * the host's own sign-in address opens in a new tab, or the app's own address, which the host
 * answers with its sign-in. */
export function signInAgain(signIn?: string, win: Window = window): void {
  if (sendToHost({ starscape: 1, type: 'sign-in' }, win)) return;
  const target = safeLink(signIn, win.location.href) ?? new URL(appHome(appMount(win.document, win.location.pathname)), win.location.origin).href;
  win.open(target, '_blank', 'noopener');
}

// --- from the host ---------------------------------------------------------------------------------

/** A tab hidden this long lets go of its live feeds: every hidden tab would otherwise hold one all day. */
export const HIDDEN_PAUSE_MS = 60_000;

/** Where `navigate` asks the app to go: a project (the open one when absent), a file in it, and the
 * link its writes then name (`orbit:card/<board>/<n>`), already checked against the server's rule. */
export type NavigateTarget = { project?: string; path?: string; context?: string };

export type FrameBridgeOptions = {
  /** The page to bridge: the real one unless a test gives its own. */
  win?: Window;
  /** Open this project and file (`navigate`). */
  onNavigate: (target: NavigateTarget) => void;
  /** Which app says `ready`, and its version. */
  app?: string;
  version?: string;
  /** What hidden and shown do to the live feeds: every open store's pause and resume. */
  pause?: () => void;
  resume?: () => void;
  /** A signed-out store looks again when the frame is shown. */
  retry?: () => void;
  hiddenAfterMs?: number;
};

export type FrameBridge = {
  /** The workspace is up: tells the host, once. */
  ready(): void;
  /** The active file changed: tells the host, when the title is new. */
  title(title: string): void;
  stop(): void;
};

type Shortcut = { raw: string; key: string; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean };

const isApple = (win: Window) => /Mac|iPhone|iPad/.test(win.navigator?.userAgent ?? '');

/** `Mod+K`, `Ctrl+Shift+P`, `Escape`: modifiers (`Mod` is ⌘ on Apple devices and Ctrl elsewhere,
 * `Ctrl`, `Meta`, `Alt`, `Shift`) then a `KeyboardEvent.key`, joined by `+`. */
function parseShortcut(raw: string, apple: boolean): Shortcut | null {
  const parts = raw.split('+');
  const key = parts[parts.length - 1] || (raw.length > 0 ? '+' : '');
  if (!key) return null;
  const shortcut: Shortcut = { raw, key: key.toLowerCase(), ctrl: false, meta: false, alt: false, shift: false };
  for (const word of parts.slice(0, -1)) {
    switch (word.toLowerCase()) {
      case '':
        break;
      case 'mod':
        if (apple) shortcut.meta = true;
        else shortcut.ctrl = true;
        break;
      case 'ctrl':
      case 'control':
        shortcut.ctrl = true;
        break;
      case 'meta':
      case 'cmd':
      case 'command':
        shortcut.meta = true;
        break;
      case 'alt':
      case 'option':
        shortcut.alt = true;
        break;
      case 'shift':
        shortcut.shift = true;
        break;
      default:
        return null;
    }
  }
  return shortcut;
}

function matches(event: KeyboardEvent, shortcut: Shortcut): boolean {
  return (
    event.key.toLowerCase() === shortcut.key &&
    event.ctrlKey === shortcut.ctrl &&
    event.metaKey === shortcut.meta &&
    event.altKey === shortcut.alt &&
    event.shiftKey === shortcut.shift
  );
}

/** Typing in a field: a key with no ctrl, meta or alt is text, never the host's. */
function typingText(event: KeyboardEvent, shortcut: Shortcut): boolean {
  if (shortcut.ctrl || shortcut.meta || shortcut.alt) return false;
  const target = event.target as HTMLElement | null;
  return target instanceof HTMLElement && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName));
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** Starts the bridge: the host's messages (only when framed, only from the parent on the app's own
 * origin), the pausing of the live feeds, and what the app tells the host. */
export function startFrameBridge(options: FrameBridgeOptions): FrameBridge {
  const win = options.win ?? window;
  const doc = win.document;
  const pause = options.pause ?? pauseFeeds;
  const resume = options.resume ?? resumeFeeds;
  const retry = options.retry ?? (() => void retryAccounts());
  const framed = isFramed(win);

  // Paused while the host says the frame is hidden, or this tab has been for a while. Resumed from
  // the stores' own cursors when neither holds, so nothing made meanwhile is missed.
  let frameHidden = false;
  let tabHidden = false;
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  let paused = false;
  const settle = () => {
    const wanted = frameHidden || tabHidden;
    if (wanted === paused) return;
    paused = wanted;
    if (wanted) pause();
    else resume();
  };
  const onVisibility = () => {
    if (hiddenTimer !== null) win.clearTimeout(hiddenTimer);
    hiddenTimer = null;
    if (doc.hidden) {
      hiddenTimer = win.setTimeout(() => {
        hiddenTimer = null;
        tabHidden = true;
        settle();
      }, options.hiddenAfterMs ?? HIDDEN_PAUSE_MS);
    } else {
      tabHidden = false;
      settle();
    }
  };
  doc.addEventListener('visibilitychange', onVisibility);
  if (doc.hidden) onVisibility();

  let shortcuts: Shortcut[] = [];
  const onKey = (event: KeyboardEvent) => {
    if (event.isComposing || event.repeat) return;
    const shortcut = shortcuts.find((candidate) => matches(event, candidate));
    if (!shortcut || typingText(event, shortcut)) return;
    // The host keeps this key: Nebula doesn't act on it, and sends it on.
    event.preventDefault();
    event.stopImmediatePropagation();
    sendToHost({ starscape: 1, type: 'shortcut', key: shortcut.raw }, win);
  };

  const onMessage = (event: MessageEvent) => {
    if (event.source !== win.parent || event.origin !== win.location.origin) return;
    const message = event.data as Partial<HostMessage> | null;
    if (typeof message !== 'object' || message === null || message.starscape !== 1) return;
    switch (message.type) {
      case 'hello': {
        const list = (message as { shortcuts?: unknown }).shortcuts;
        const apple = isApple(win);
        shortcuts = Array.isArray(list) ? list.flatMap((raw) => (typeof raw === 'string' ? (parseShortcut(raw, apple) ?? []) : [])) : [];
        win.removeEventListener('keydown', onKey, true);
        if (shortcuts.length > 0) win.addEventListener('keydown', onKey, true);
        break;
      }
      case 'visibility': {
        const visible = (message as { visible?: unknown }).visible;
        if (typeof visible !== 'boolean') break;
        frameHidden = !visible;
        settle();
        if (visible) retry();
        break;
      }
      case 'navigate': {
        const { project, path, context } = message as { project?: unknown; path?: unknown; context?: unknown };
        const target: NavigateTarget = {};
        if (text(project)) target.project = text(project);
        if (text(path)) target.path = text(path);
        // A value the server would refuse is dropped here, never sent on with a write.
        if (isContextLink(context)) target.context = context;
        if (target.project || target.path) options.onNavigate(target);
        break;
      }
    }
  };
  if (framed) win.addEventListener('message', onMessage);

  let sentReady = false;
  let lastTitle: string | null = null;
  return {
    ready() {
      if (sentReady) return;
      sentReady = true;
      sendToHost({ starscape: 1, type: 'ready', app: options.app ?? 'nebula', version: options.version ?? '' }, win);
    },
    title(title) {
      if (title === lastTitle) return;
      lastTitle = title;
      sendToHost({ starscape: 1, type: 'title', title }, win);
    },
    stop() {
      doc.removeEventListener('visibilitychange', onVisibility);
      win.removeEventListener('message', onMessage);
      win.removeEventListener('keydown', onKey, true);
      if (hiddenTimer !== null) win.clearTimeout(hiddenTimer);
      hiddenTimer = null;
      // A bridge that goes while it holds the feeds paused gives them back.
      if (paused) {
        paused = false;
        resume();
      }
    },
  };
}
