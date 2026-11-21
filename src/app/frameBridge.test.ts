/**
 * The frame bridge (src/app/frameBridge.ts) against a fake window: it listens only when framed,
 * only to its own parent on its own origin, and posts only there with its own origin as the
 * target. A page that isn't framed hears and says nothing. The pausing of the feeds, the host's
 * keys and `navigate` are checked here by what they call, not by any wording.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeLink, signInAgain, startFrameBridge, isFramed, sendToHost, type FrameBridge, type NavigateTarget } from './frameBridge';

const ORIGIN = 'https://app.test';

type Listener = (event: never) => void;

/** Listeners kept per type in the order they were added; `fire` stops at stopImmediatePropagation. */
class Target {
  readonly listeners = new Map<string, Listener[]>();
  addEventListener(type: string, listener: Listener): void {
    const held = this.listeners.get(type) ?? [];
    if (held.includes(listener)) return; // as the DOM does: the same listener is added once
    this.listeners.set(type, [...held, listener]);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
  }
  count(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }
  fire(type: string, event: object): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event as never);
      if ((event as { stopped?: boolean }).stopped) return;
    }
  }
}

class FakeWindow extends Target {
  parent: unknown;
  readonly location: { origin: string; href: string; pathname: string };
  readonly navigator: { userAgent: string };
  readonly document: Target & { hidden: boolean; baseURI: string; querySelector: (selector: string) => unknown };
  readonly open = vi.fn();
  readonly postMessage = vi.fn();
  readonly parentPost = vi.fn();
  setTimeout = (...args: Parameters<typeof setTimeout>) => setTimeout(...args);
  clearTimeout = (id: Parameters<typeof clearTimeout>[0]) => clearTimeout(id);

  constructor(options: { framed?: boolean; userAgent?: string; pathname?: string; base?: string | null } = {}) {
    super();
    const pathname = options.pathname ?? '/app/p/night-sky';
    this.location = { origin: ORIGIN, href: `${ORIGIN}${pathname}`, pathname };
    this.navigator = { userAgent: options.userAgent ?? 'Mozilla/5.0 (X11; Linux x86_64)' };
    const doc = Object.assign(new Target(), {
      hidden: false,
      baseURI: options.base ? `${ORIGIN}${options.base}` : this.location.href,
      querySelector: (): unknown => (options.base ? {} : null),
    });
    this.document = doc;
    this.parent = options.framed === false ? this : { postMessage: this.parentPost };
  }

  get host(): Window {
    return this as unknown as Window;
  }

  /** What the host (or someone) posts to the app. */
  message(data: unknown, from: { source?: unknown; origin?: string } = {}): void {
    this.fire('message', { data, source: 'source' in from ? from.source : this.parent, origin: from.origin ?? ORIGIN });
  }

  hide(hidden: boolean): void {
    this.document.hidden = hidden;
    this.document.fire('visibilitychange', {});
  }

  key(init: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; target?: unknown; isComposing?: boolean; repeat?: boolean }) {
    const event = {
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      repeat: false,
      target: null as unknown,
      defaultPrevented: false,
      stopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopImmediatePropagation() {
        this.stopped = true;
      },
      ...init,
    };
    this.fire('keydown', event);
    return event;
  }

  /** Everything the app posted to its parent: [message, targetOrigin]. */
  sent(): unknown[][] {
    return this.parentPost.mock.calls;
  }
}

const bridges: FrameBridge[] = [];

function start(options: ConstructorParameters<typeof FakeWindow>[0] = {}, extra: Partial<Parameters<typeof startFrameBridge>[0]> = {}) {
  const win = new FakeWindow(options);
  const onNavigate = vi.fn<(target: NavigateTarget) => void>();
  const pause = vi.fn();
  const resume = vi.fn();
  const retry = vi.fn();
  const bridge = startFrameBridge({ win: win.host, onNavigate, pause, resume, retry, version: '2.0.4', ...extra });
  bridges.push(bridge);
  return { win, bridge, onNavigate, pause, resume, retry };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.stop();
  vi.useRealTimers();
});

describe('only when framed', () => {
  it('an unframed page adds no message listener and sends nothing', () => {
    const { win, bridge, onNavigate } = start({ framed: false });
    expect(win.count('message')).toBe(0);
    bridge.ready();
    bridge.title('Orion · Night Sky');
    win.message({ starscape: 1, type: 'hello', shortcuts: ['Mod+K'] }, { source: win });
    win.message({ starscape: 1, type: 'navigate', project: 'p' }, { source: win });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(win.count('keydown')).toBe(0);
    expect(win.postMessage).not.toHaveBeenCalled();
    expect(win.parentPost).not.toHaveBeenCalled();
    expect(sendToHost({ starscape: 1, type: 'sign-in' }, win.host)).toBe(false);
  });

  it('a framed page does the same things and is the one that listens and sends', () => {
    const { win, bridge, onNavigate } = start();
    expect(isFramed(win.host)).toBe(true);
    expect(win.count('message')).toBe(1);
    win.message({ starscape: 1, type: 'navigate', project: 'p' });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    bridge.ready();
    expect(win.sent()).toHaveLength(1);
  });

  it('a page whose parent can’t be read is not framed', () => {
    const win = {
      get parent(): never {
        throw new Error('cross-origin');
      },
    };
    expect(isFramed(win as unknown as Window)).toBe(false);
  });
});

describe('who it listens to', () => {
  const navigate = { starscape: 1, type: 'navigate', project: 'night-sky' };

  it('acts on a message from its parent, on its own origin, marked starscape 1', () => {
    const { win, onNavigate } = start();
    win.message(navigate);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith({ project: 'night-sky' });
  });

  it('does nothing for another origin, another window, or a message with no starscape mark', () => {
    const { win, onNavigate, pause } = start();
    win.message(navigate, { origin: 'https://evil.test' });
    win.message(navigate, { origin: `${ORIGIN}.evil.test` });
    win.message(navigate, { origin: 'null' });
    win.message(navigate, { source: {} });
    win.message(navigate, { source: null });
    win.message(navigate, { source: win });
    win.message({ type: 'navigate', project: 'night-sky' });
    win.message({ ...navigate, starscape: 2 });
    win.message({ ...navigate, starscape: '1' });
    win.message(null);
    win.message('navigate');
    win.message({ starscape: 1, type: 'visibility', visible: false }, { origin: 'https://evil.test' });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });

  it('a hello from the wrong sender never gives anyone the keys', () => {
    const { win } = start();
    win.message({ starscape: 1, type: 'hello', shortcuts: ['Mod+K'] }, { origin: 'https://evil.test' });
    expect(win.count('keydown')).toBe(0);
  });

  it('an unknown message type does nothing', () => {
    const { win, onNavigate, pause, resume } = start();
    win.message({ starscape: 1, type: 'eval', code: 'x' });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });
});

describe('where it sends', () => {
  it('everything goes to the parent with the app’s own origin as the target, never *', () => {
    const { win, bridge } = start();
    win.message({ starscape: 1, type: 'hello', shortcuts: ['Mod+K'] });
    bridge.ready();
    bridge.title('Orion · Night Sky');
    win.key({ key: 'k', ctrlKey: true });
    signInAgain(undefined, win.host);
    expect(win.sent().map(([message]) => (message as { type: string }).type)).toEqual(['ready', 'title', 'shortcut', 'sign-in']);
    for (const [, target] of win.sent()) expect(target).toBe(ORIGIN);
    expect(win.postMessage).not.toHaveBeenCalled(); // to itself: nothing
  });

  it('ready goes once, with the app and its version; a title goes again only when it changes', () => {
    const { win, bridge } = start();
    bridge.ready();
    bridge.ready();
    bridge.title('Orion · Night Sky');
    bridge.title('Orion · Night Sky');
    bridge.title('Nebula');
    bridge.title('Orion · Night Sky');
    expect(win.sent().map(([message]) => message)).toEqual([
      { starscape: 1, type: 'ready', app: 'nebula', version: '2.0.4' },
      { starscape: 1, type: 'title', title: 'Orion · Night Sky' },
      { starscape: 1, type: 'title', title: 'Nebula' },
      { starscape: 1, type: 'title', title: 'Orion · Night Sky' },
    ]);
  });
});

describe('Sign in again', () => {
  it('framed, it posts sign-in to the parent with the app’s origin and opens nothing', () => {
    const { win } = start();
    signInAgain('https://suite.test/sign-in', win.host);
    expect(win.sent()).toEqual([[{ starscape: 1, type: 'sign-in' }, ORIGIN]]);
    expect(win.open).not.toHaveBeenCalled();
  });

  it('not framed, it opens the host’s sign-in address in a new tab, noopener', () => {
    const { win } = start({ framed: false });
    signInAgain('https://suite.test/sign-in?next=%2Fnebula', win.host);
    expect(win.open).toHaveBeenCalledTimes(1);
    expect(win.open).toHaveBeenCalledWith('https://suite.test/sign-in?next=%2Fnebula', '_blank', 'noopener');
    expect(win.parentPost).not.toHaveBeenCalled();
  });

  it('not framed, with no address or an unsafe one, it opens the app’s own address under its mount', () => {
    for (const unsafe of [undefined, '', 'javascript:alert(1)', 'data:text/html,x', 'ftp://x.test/']) {
      const { win } = start({ framed: false, pathname: '/app/p/night-sky' });
      signInAgain(unsafe, win.host);
      expect(win.open).toHaveBeenCalledWith(`${ORIGIN}/app`, '_blank', 'noopener');
    }
    const root = start({ framed: false, pathname: '/p/night-sky' });
    signInAgain(undefined, root.win.host);
    expect(root.win.open).toHaveBeenCalledWith(`${ORIGIN}/`, '_blank', 'noopener');
    const mounted = start({ framed: false, pathname: '/nebula/p/night-sky', base: '/nebula/' });
    signInAgain(undefined, mounted.win.host);
    expect(mounted.win.open).toHaveBeenCalledWith(`${ORIGIN}/nebula`, '_blank', 'noopener');
  });
});

describe('safeLink', () => {
  it('gives an absolute http(s) address and nothing else', () => {
    expect(safeLink('https://suite.test/plans', 'https://app.test/')).toBe('https://suite.test/plans');
    expect(safeLink('http://suite.test/plans', 'https://app.test/')).toBe('http://suite.test/plans');
    expect(safeLink('/plans', 'https://app.test/app')).toBe('https://app.test/plans');
    for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'blob:https://x.test/1', '', undefined, null]) {
      expect(safeLink(bad, 'https://app.test/')).toBeNull();
    }
  });
});

describe('pausing the feeds', () => {
  it('the frame hidden pauses once, shown resumes and asks signed-out stores to look again', () => {
    const { win, pause, resume, retry } = start();
    win.message({ starscape: 1, type: 'visibility', visible: false });
    win.message({ starscape: 1, type: 'visibility', visible: false });
    expect(pause).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    win.message({ starscape: 1, type: 'visibility', visible: true });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('a visible frame that was never hidden resumes nothing, and still asks to look again', () => {
    const { win, pause, resume, retry } = start();
    win.message({ starscape: 1, type: 'visibility', visible: true });
    expect(pause).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('a visible that isn’t a boolean does nothing', () => {
    const { win, pause, resume, retry } = start();
    for (const visible of ['false', 0, null, undefined, {}]) win.message({ starscape: 1, type: 'visibility', visible });
    expect(pause).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it('a tab hidden for 60 s pauses (59 s does not); visible again resumes', () => {
    const { win, pause, resume } = start({ framed: false });
    win.hide(true);
    vi.advanceTimersByTime(59_000);
    expect(pause).not.toHaveBeenCalled();
    win.hide(false);
    vi.advanceTimersByTime(120_000); // shown in time: the clock was cancelled
    expect(pause).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();

    win.hide(true);
    vi.advanceTimersByTime(60_000);
    expect(pause).toHaveBeenCalledTimes(1);
    win.hide(false);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('a page that starts out hidden starts the clock', () => {
    const win = new FakeWindow({ framed: false });
    win.document.hidden = true;
    const pause = vi.fn();
    bridges.push(startFrameBridge({ win: win.host, onNavigate: vi.fn(), pause, resume: vi.fn(), retry: vi.fn() }));
    vi.advanceTimersByTime(60_000);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('the frame’s hidden and the tab’s hidden hold the pause together', () => {
    const { win, pause, resume } = start();
    win.message({ starscape: 1, type: 'visibility', visible: false });
    win.hide(true);
    vi.advanceTimersByTime(60_000);
    expect(pause).toHaveBeenCalledTimes(1); // already paused: no second call
    win.message({ starscape: 1, type: 'visibility', visible: true });
    expect(resume).not.toHaveBeenCalled(); // the tab is still hidden
    win.hide(false);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('a bridge that stops while paused gives the feeds back, and one that isn’t paused resumes nothing', () => {
    const idle = start();
    idle.bridge.stop();
    expect(idle.resume).not.toHaveBeenCalled();

    const { win, bridge, resume } = start();
    win.message({ starscape: 1, type: 'visibility', visible: false });
    bridge.stop();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(win.count('message')).toBe(0);
    expect(win.document.count('visibilitychange')).toBe(0);
  });
});

describe('the host’s keys', () => {
  const hello = (win: FakeWindow, shortcuts: unknown) => win.message({ starscape: 1, type: 'hello', shortcuts });

  it('Mod is Ctrl off Apple devices and ⌘ on them; the modifiers must be exactly those', () => {
    const linux = start();
    hello(linux.win, ['Mod+K']);
    expect(linux.win.key({ key: 'k', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(linux.win.key({ key: 'K', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(linux.win.key({ key: 'k', metaKey: true }).defaultPrevented).toBe(false);
    expect(linux.win.key({ key: 'k', ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(linux.win.key({ key: 'k', ctrlKey: true, altKey: true }).defaultPrevented).toBe(false);
    expect(linux.win.key({ key: 'k' }).defaultPrevented).toBe(false);

    const mac = start({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' });
    hello(mac.win, ['Mod+K']);
    expect(mac.win.key({ key: 'k', metaKey: true }).defaultPrevented).toBe(true);
    expect(mac.win.key({ key: 'k', ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it('matches Ctrl+Shift+P, Alt+Shift+ArrowLeft and Escape on KeyboardEvent.key, and sends the host’s own string', () => {
    const { win } = start();
    hello(win, ['Ctrl+Shift+P', 'Alt+Shift+ArrowLeft', 'Escape']);
    expect(win.key({ key: 'P', ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(win.key({ key: 'ArrowLeft', altKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(win.key({ key: 'Escape' }).defaultPrevented).toBe(true);
    expect(win.key({ key: 'ArrowRight', altKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(win.sent().map(([message]) => (message as { key: string }).key)).toEqual(['Ctrl+Shift+P', 'Alt+Shift+ArrowLeft', 'Escape']);
  });

  it('a match is not acted on: default prevented and no later listener runs', () => {
    const { win } = start();
    const nebulaSearch = vi.fn();
    hello(win, ['Mod+K']);
    win.addEventListener('keydown', nebulaSearch); // Nebula's own Ctrl/⌘-K, added after the bridge
    win.key({ key: 'k', ctrlKey: true });
    expect(nebulaSearch).not.toHaveBeenCalled();
    // A key the host didn't list reaches Nebula as before.
    win.key({ key: 'j', ctrlKey: true });
    expect(nebulaSearch).toHaveBeenCalledTimes(1);
  });

  it('with nothing listed, Ctrl/⌘-K is Nebula’s', () => {
    const { win } = start();
    const nebulaSearch = vi.fn();
    win.addEventListener('keydown', nebulaSearch);
    expect(win.key({ key: 'k', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(nebulaSearch).toHaveBeenCalledTimes(1);
    expect(win.sent()).toEqual([]);
  });

  it('a key with no modifier typed into a field is text, and a chord in a field is still the host’s', () => {
    const { win } = start();
    hello(win, ['Escape', 'Mod+K']);
    for (const target of [document.createElement('input'), document.createElement('textarea'), document.createElement('select')]) {
      expect(win.key({ key: 'Escape', target }).defaultPrevented).toBe(false);
    }
    const editable = document.createElement('div');
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(win.key({ key: 'Escape', target: editable }).defaultPrevented).toBe(false);
    expect(win.key({ key: 'Escape', target: document.createElement('div') }).defaultPrevented).toBe(true);
    expect(win.key({ key: 'k', ctrlKey: true, target: document.createElement('input') }).defaultPrevented).toBe(true);
  });

  it('a key held down or typed through an input method is left alone', () => {
    const { win } = start();
    hello(win, ['Escape']);
    expect(win.key({ key: 'Escape', repeat: true }).defaultPrevented).toBe(false);
    expect(win.key({ key: 'Escape', isComposing: true }).defaultPrevented).toBe(false);
    expect(win.key({ key: 'Escape' }).defaultPrevented).toBe(true);
  });

  it('unknown modifiers and non-strings are dropped, and the rest are kept', () => {
    const { win } = start();
    hello(win, ['Hyper+K', 42, null, {}, ['Mod+L'], '', 'Mod+J']);
    expect(win.key({ key: 'k' }).defaultPrevented).toBe(false);
    expect(win.key({ key: 'k', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(win.key({ key: 'l', ctrlKey: true }).defaultPrevented).toBe(false); // a list is not a string
    expect(win.key({ key: 'j', ctrlKey: true }).defaultPrevented).toBe(true);
    const none = start();
    hello(none.win, 'Mod+K'); // not a list
    expect(none.win.count('keydown')).toBe(0);
  });

  it('a later hello replaces the list, and an empty one removes the listener', () => {
    const { win } = start();
    hello(win, ['Mod+K']);
    hello(win, ['Mod+J']);
    expect(win.count('keydown')).toBe(1);
    expect(win.key({ key: 'k', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(win.key({ key: 'j', ctrlKey: true }).defaultPrevented).toBe(true);
    hello(win, []);
    expect(win.count('keydown')).toBe(0);
    expect(win.key({ key: 'j', ctrlKey: true }).defaultPrevented).toBe(false);
  });
});

describe('navigate', () => {
  it('passes the project, the path and a context the server would accept', () => {
    const { win, onNavigate } = start();
    win.message({ starscape: 1, type: 'navigate', project: 'night-sky', path: 'Guides/Orion.md', context: 'orbit:card/board/7' });
    expect(onNavigate).toHaveBeenLastCalledWith({ project: 'night-sky', path: 'Guides/Orion.md', context: 'orbit:card/board/7' });
    win.message({ starscape: 1, type: 'navigate', path: 'Guides/Orion.md' }); // the open project
    expect(onNavigate).toHaveBeenLastCalledWith({ path: 'Guides/Orion.md' });
    win.message({ starscape: 1, type: 'navigate', project: 'night-sky' });
    expect(onNavigate).toHaveBeenLastCalledWith({ project: 'night-sky' });
  });

  it('drops a context that fails the server’s rule and still opens the file', () => {
    const { win, onNavigate } = start();
    for (const context of ['orbit:card/a b/1', `orbit:card/${'x'.repeat(246)}`, 5, null, '']) {
      win.message({ starscape: 1, type: 'navigate', project: 'night-sky', path: 'a.md', context });
      expect(onNavigate).toHaveBeenLastCalledWith({ project: 'night-sky', path: 'a.md' });
    }
    expect(onNavigate).toHaveBeenCalledTimes(5);
  });

  it('with neither a project nor a path it does nothing, however much else it says', () => {
    const { win, onNavigate } = start();
    win.message({ starscape: 1, type: 'navigate' });
    win.message({ starscape: 1, type: 'navigate', context: 'orbit:card/b/1' });
    win.message({ starscape: 1, type: 'navigate', project: '', path: '' });
    win.message({ starscape: 1, type: 'navigate', project: 7, path: ['a.md'] });
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
