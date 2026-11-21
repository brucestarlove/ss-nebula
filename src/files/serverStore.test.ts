/**
 * HttpFileStore against a fake `fetch`: what it makes of each answer (signed out, space full, a
 * server that is down), how the change feed stops and resumes, the Orbit card's context header,
 * and the history calls' requests. The fake refuses every address but its own, so a red run
 * can't reach a real server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileChangedError, FileNotFoundError } from './errors';
import { pauseFeeds, resumeFeeds, retryAccounts } from './account';
import { HttpFileStore, ServerError, ServerUnreachableError, SignedOutError, SpaceFullError } from './serverStore';
import type { FileChange } from './types';

const ORIGIN = 'http://nebula.test';
const API = '/nebula-api/v1';

// jsdom's realm has no ReadableStream: Node's own, without Node's types in the app's tsconfig.
type StreamController = { enqueue(chunk: Uint8Array): void; close(): void };
const NodeReadableStream = (globalThis as unknown as { process: { getBuiltinModule(id: string): { ReadableStream: new (source: { start(controller: StreamController): void }) => unknown } } }).process.getBuiltinModule('node:stream/web').ReadableStream;

type Req = { url: URL; method: string; headers: Headers; body: unknown; signal?: AbortSignal | null };
type Handler = (req: Req) => Response | Promise<Response>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const bodiless = (status: number) => new Response(null, { status });

/** An event stream the test feeds by hand. */
function stream() {
  const encoder = new TextEncoder();
  let controller!: StreamController;
  const body = new NodeReadableStream({ start: (c) => void (controller = c) });
  return {
    response: new Response(body as BodyInit, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    send: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => {
      try {
        controller.close();
      } catch {
        // already cancelled
      }
    },
  };
}

let calls: Req[] = [];
let handler: Handler;
const stores: HttpFileStore[] = [];

function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  if (url.origin !== ORIGIN) throw new Error(`the test reached for ${url.origin}`);
  const req: Req = { url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body, signal: init.signal };
  calls.push(req);
  return Promise.resolve(handler(req));
}

function make(options: Partial<ConstructorParameters<typeof HttpFileStore>[0]> = {}): HttpFileStore {
  const store = new HttpFileStore({ projectId: 'p1', label: 'vps', base: ORIGIN, fetch: fakeFetch as typeof fetch, ...options });
  stores.push(store);
  return store;
}

const where = (action: string, method?: string) => calls.filter((c) => c.url.pathname.endsWith(`/${action}`) && (!method || c.method === method));
const events = () => where('events');

beforeEach(() => {
  calls = [];
  handler = () => json({ error: 'unexpected' }, 500);
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('what an answer means', () => {
  it('a 401 is SignedOutError for a read and for a write, with the host’s sign-in address when it gave one', async () => {
    handler = () => json({ error: 'signed-out', message: 'Session ended', signIn: 'https://suite.test/sign-in' }, 401);
    const store = make();
    const read = await store.readText('a.md').catch((e: unknown) => e);
    expect(read).toBeInstanceOf(SignedOutError);
    expect((read as SignedOutError).signIn).toBe('https://suite.test/sign-in');
    const write = await store.write('a.md', 'x').catch((e: unknown) => e);
    expect(write).toBeInstanceOf(SignedOutError);
    expect(store.signedOut()).toEqual({ signIn: 'https://suite.test/sign-in' });
  });

  it('a 401 with no body is signed out too', async () => {
    handler = () => bodiless(401);
    const store = make();
    await expect(store.list()).rejects.toBeInstanceOf(SignedOutError);
    await expect(store.write('a.md', 'x')).rejects.toBeInstanceOf(SignedOutError);
    expect(store.signedOut()).toEqual({});
  });

  it('a 507 space-full is SpaceFullError with used, limit and upgrade', async () => {
    handler = () => json({ error: 'space-full', used: 120, limit: 1000, upgrade: 'https://suite.test/plans' }, 507);
    const store = make();
    const error = await store.write('a.md', 'x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpaceFullError);
    expect(error).toMatchObject({ used: 120, limit: 1000, upgrade: 'https://suite.test/plans' });
    // A full space is a fact about the person, not a reason to say the session ended.
    expect(store.signedOut()).toBeNull();
  });

  it('a 507 with another code stays a ServerError', async () => {
    handler = () => json({ error: 'disk', message: 'No room on the disk' }, 507);
    const error = await make().write('a.md', 'x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerError);
    expect(error).not.toBeInstanceOf(SpaceFullError);
    expect(error).toMatchObject({ status: 507, code: 'disk' });
  });

  it('a 5xx is ServerUnreachableError, and a fetch that throws is too', async () => {
    handler = () => json({ error: 'boom' }, 503);
    const store = make();
    await expect(store.readText('a.md')).rejects.toBeInstanceOf(ServerUnreachableError);
    handler = () => Promise.reject(new TypeError('network'));
    await expect(store.readText('a.md')).rejects.toBeInstanceOf(ServerUnreachableError);
    expect(store.signedOut()).toBeNull();
  });

  it('an answer of 4xx other than 401 keeps the server’s code', async () => {
    handler = () => json({ error: 'invalid-context', message: 'no' }, 400);
    await expect(make().write('a.md', 'x')).rejects.toMatchObject({ name: 'ServerError', status: 400, code: 'invalid-context' });
  });
});

describe('the feed while signed out', () => {
  /** Answers events with a stream the test holds, and state and the rest with `ok`. */
  function serve(opts: { out: () => boolean }) {
    const streams: ReturnType<typeof stream>[] = [];
    handler = (req) => {
      if (req.url.pathname.endsWith('/events')) {
        if (opts.out()) return bodiless(401);
        const s = stream();
        streams.push(s);
        return s.response;
      }
      if (opts.out()) return bodiless(401);
      return json({ cursor: 'c0' });
    };
    return streams;
  }

  it('a 401 stops the retries and is no outage: no more events requests, one signed-out, nothing for watchers', async () => {
    vi.useFakeTimers();
    let out = false;
    const streams = serve({ out: () => out });
    const store = make(); // the refusal comes within the grace, so the drop was never an outage
    const heard: FileChange[] = [];
    const account: string[] = [];
    store.onAccount((status) => account.push(status));
    store.watch((change) => heard.push(change));
    await vi.advanceTimersByTimeAsync(10);
    expect(events()).toHaveLength(1);

    out = true;
    streams[0].end(); // the connection drops; the reconnect is refused
    await vi.advanceTimersByTimeAsync(2_000);
    const refused = events().length;
    expect(refused).toBe(2);
    expect(account).toEqual(['signed-out']);
    expect(store.signedOut()).toEqual({});

    await vi.advanceTimersByTimeAsync(60_000);
    expect(events()).toHaveLength(refused);
    expect(account).toEqual(['signed-out']);
    expect(heard).toEqual([]);
  });

  it('a request that is answered says signed-in once and the feed restarts since the cursor it held', async () => {
    vi.useFakeTimers();
    let out = false;
    const streams = serve({ out: () => out });
    const store = make();
    const account: string[] = [];
    store.onAccount((status) => account.push(status));
    store.watch(() => {});
    await vi.advanceTimersByTimeAsync(10);
    streams[0].send('id: c7\nevent: change\ndata: {"change":{"type":"write","path":"a.md"},"by":"someone"}\n\n');
    await vi.advanceTimersByTimeAsync(10);
    out = true;
    streams[0].end();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.signedOut()).not.toBeNull();
    const before = events().length;

    out = false;
    await store.retryAccount();
    await store.retryAccount(); // signed in: quiet
    await vi.advanceTimersByTimeAsync(10);
    expect(account).toEqual(['signed-out', 'signed-in']);
    expect(store.signedOut()).toBeNull();
    expect(events()).toHaveLength(before + 1);
    expect(events().at(-1)?.url.searchParams.get('since')).toBe('c7');
  });

  it('while signed out, neither a new watcher nor resume starts the feed', async () => {
    vi.useFakeTimers();
    handler = () => bodiless(401);
    const store = make();
    store.watch(() => {});
    await vi.advanceTimersByTimeAsync(10);
    expect(store.signedOut()).not.toBeNull();
    const asked = events().length;
    store.watch(() => {});
    store.pause();
    store.resume();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(events()).toHaveLength(asked);
  });

  it('a request of the app’s own that is answered while signed out also says signed-in', async () => {
    let out = true;
    handler = () => (out ? bodiless(401) : json({ entries: [] }));
    const store = make();
    const account: string[] = [];
    store.onAccount((status) => account.push(status));
    await expect(store.list()).rejects.toBeInstanceOf(SignedOutError);
    await expect(store.list()).rejects.toBeInstanceOf(SignedOutError);
    expect(account).toEqual(['signed-out']); // once, however many requests are refused
    out = false;
    await store.list();
    expect(account).toEqual(['signed-out', 'signed-in']);
  });

  it('a redirected 200 (a host’s sign-in page) is no answer', async () => {
    let mode: 'out' | 'redirected' | 'ok' = 'out';
    handler = () => {
      if (mode === 'out') return bodiless(401);
      const response = json({ cursor: 'c1' });
      if (mode === 'redirected') Object.defineProperty(response, 'redirected', { value: true });
      return response;
    };
    const store = make();
    const account: string[] = [];
    store.onAccount((status) => account.push(status));
    await store.list().catch(() => {});
    mode = 'redirected';
    await store.retryAccount();
    expect(account).toEqual(['signed-out']);
    expect(store.signedOut()).not.toBeNull();
    mode = 'ok';
    await store.retryAccount();
    expect(account).toEqual(['signed-out', 'signed-in']);
  });

  it('a refused retry says nothing new, and an unreachable server says nothing at all', async () => {
    handler = () => bodiless(401);
    const store = make();
    const account: string[] = [];
    store.onAccount((status) => account.push(status));
    await store.list().catch(() => {});
    await store.retryAccount();
    handler = () => Promise.reject(new TypeError('network'));
    await store.retryAccount();
    expect(account).toEqual(['signed-out']);
    expect(store.signedOut()).not.toBeNull();
  });

  it('if the feed had said unreachable before the 401, reachable follows', async () => {
    vi.useFakeTimers();
    let phase: 'down' | 'out' = 'down';
    handler = (req) => {
      if (phase === 'down') return Promise.reject(new TypeError('network'));
      return bodiless(req.url.pathname.endsWith('/events') ? 401 : 401);
    };
    const store = make({ graceMs: 500 });
    const heard: string[] = [];
    store.watch((change) => heard.push(change.type));
    await vi.advanceTimersByTimeAsync(700);
    expect(heard).toEqual(['unreachable']);
    phase = 'out';
    await vi.advanceTimersByTimeAsync(3_000);
    expect(heard).toEqual(['unreachable', 'reachable']);
    expect(store.signedOut()).not.toBeNull();
  });

  it('a 401 with no outage before it says no outage at all', async () => {
    vi.useFakeTimers();
    handler = () => bodiless(401);
    const store = make({ graceMs: 100 });
    const heard: string[] = [];
    store.watch((change) => heard.push(change.type));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(heard).toEqual([]);
    expect(events()).toHaveLength(1);
  });
});

describe('the return of the tab while signed out', () => {
  const visibility = (state: 'visible' | 'hidden') => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  afterEach(() => {
    delete (document as { visibilityState?: unknown }).visibilityState;
  });

  async function signedOutStore(): Promise<HttpFileStore> {
    handler = () => bodiless(401);
    const store = make();
    await store.list().catch(() => {});
    handler = () => bodiless(401);
    calls = [];
    return store;
  }

  it('a tab that regains focus or becomes visible looks again; a hidden one does not', async () => {
    const store = await signedOutStore();
    expect(store.signedOut()).not.toBeNull();
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(where('state')).toHaveLength(1));
    visibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(where('state')).toHaveLength(1);
    visibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(where('state')).toHaveLength(2));
  });

  it('the listeners are gone once every store is signed in', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const a = await signedOutStore();
    const b = make({ projectId: 'p2' });
    await b.list().catch(() => {});
    expect(add.mock.calls.filter(([type]) => type === 'focus')).toHaveLength(1); // one pair for both stores
    handler = () => json({ cursor: 'c' });
    await a.retryAccount();
    expect(remove.mock.calls.filter(([type]) => type === 'focus')).toHaveLength(0); // b is still out
    await b.retryAccount();
    expect(remove.mock.calls.filter(([type]) => type === 'focus')).toHaveLength(1);
    calls = [];
    window.dispatchEvent(new Event('focus'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(0);
  });

  it('retryAccounts asks every open signed-out store to look again, and a store that is closed or signed in asks nothing', async () => {
    const out = await signedOutStore();
    const closed = make({ projectId: 'closed' });
    await closed.list().catch(() => {});
    closed.close();
    const fine = make({ projectId: 'fine' });
    calls = [];
    handler = (req) => (req.url.pathname.includes('/projects/p1/') ? bodiless(401) : json({ cursor: 'c' }));
    await retryAccounts();
    expect(where('state').map((c) => c.url.pathname)).toEqual([`${API}/projects/p1/state`]);
    expect(out.signedOut()).not.toBeNull();
    expect(fine.signedOut()).toBeNull();
  });

  it('a store that is closed takes no part', async () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const store = await signedOutStore();
    store.close();
    expect(remove.mock.calls.filter(([type]) => type === 'focus')).toHaveLength(1);
    window.dispatchEvent(new Event('focus'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(where('state')).toHaveLength(0);
    await store.retryAccount();
    expect(where('state')).toHaveLength(0);
  });
});

describe('pause and resume', () => {
  function feeds() {
    const streams: ReturnType<typeof stream>[] = [];
    const answers: Array<'ok' | 'resync' | 'down'> = [];
    handler = (req) => {
      if (!req.url.pathname.endsWith('/events')) return json({ cursor: 'c0' });
      const how = answers.shift() ?? 'ok';
      if (how === 'down') return Promise.reject(new TypeError('network'));
      const s = stream();
      streams.push(s);
      s.send(how === 'resync' ? 'event: resync\ndata: {}\n\nid: c9\nevent: ready\ndata: {}\n\n' : 'event: ready\ndata: {}\n\n');
      return s.response;
    };
    return { streams, answers };
  }

  it('pause aborts the feed and says nothing; resume continues from the cursor', async () => {
    vi.useFakeTimers();
    const { streams } = feeds();
    const store = make({ graceMs: 100, cursor: 'c0' });
    const heard: string[] = [];
    store.watch((change) => heard.push(change.type));
    await vi.advanceTimersByTimeAsync(10);
    streams[0].send('id: c4\nevent: change\ndata: {"change":{"type":"write","path":"a.md"},"by":"x"}\n\n');
    await vi.advanceTimersByTimeAsync(10);
    expect(heard).toEqual(['write']);
    const signal = events()[0].signal;

    store.pause();
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events()).toHaveLength(1); // nothing reconnects while paused
    expect(heard).toEqual(['write']); // and no `unreachable`

    store.resume();
    await vi.advanceTimersByTimeAsync(10);
    expect(events()).toHaveLength(2);
    expect(events()[1].url.searchParams.get('since')).toBe('c4');
    expect(heard).toEqual(['write']);
  });

  it('a cursor the server has dropped gives its resync, as after any drop', async () => {
    vi.useFakeTimers();
    const { answers } = feeds();
    const store = make({ cursor: 'c0' });
    const heard: string[] = [];
    store.watch((change) => heard.push(change.type));
    await vi.advanceTimersByTimeAsync(10);
    store.pause();
    answers.push('resync');
    store.resume();
    await vi.advanceTimersByTimeAsync(10);
    expect(heard).toEqual(['unreachable', 'reachable']);
  });

  it('pausing while unreachable was said, then resuming into an answer, says reachable', async () => {
    vi.useFakeTimers();
    const { answers } = feeds();
    answers.push('down');
    const store = make({ graceMs: 200, cursor: 'c0' });
    const heard: string[] = [];
    store.watch((change) => heard.push(change.type));
    await vi.advanceTimersByTimeAsync(400);
    expect(heard).toEqual(['unreachable']);
    store.pause();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(heard).toEqual(['unreachable']);
    store.resume();
    await vi.advanceTimersByTimeAsync(10);
    expect(heard).toEqual(['unreachable', 'reachable']);
  });

  it('a drop that pause cuts short never turns into an outage', async () => {
    vi.useFakeTimers();
    const { answers } = feeds();
    answers.push('down');
    const store = make({ graceMs: 500, cursor: 'c0' });
    const heard: string[] = [];
    store.watch((change) => heard.push(change.type));
    await vi.advanceTimersByTimeAsync(100); // down, within the grace
    store.pause();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(heard).toEqual([]);
  });

  it('a feed that was never watched is not started by resume', async () => {
    feeds();
    const store = make();
    store.pause();
    store.resume();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events()).toHaveLength(0);
  });

  it('pauseFeeds and resumeFeeds reach every open store, not one that was closed', async () => {
    vi.useFakeTimers();
    feeds();
    const open = make({ projectId: 'open' });
    const closed = make({ projectId: 'closed' });
    open.watch(() => {});
    closed.watch(() => {});
    await vi.advanceTimersByTimeAsync(10);
    expect(events()).toHaveLength(2);
    const [openFeed, closedFeed] = events();
    closed.close();
    expect(closedFeed.signal?.aborted).toBe(true);

    pauseFeeds();
    expect(openFeed.signal?.aborted).toBe(true);
    resumeFeeds();
    await vi.advanceTimersByTimeAsync(10);
    expect(events()).toHaveLength(3); // the open one only
    expect(events()[2].url.pathname).toContain('/projects/open/');
  });
});

describe('the card’s context', () => {
  const header = (req: Req) => req.headers.get('nebula-context');
  const okAll: Handler = (req) => {
    if (req.url.pathname.endsWith('/file') && req.method === 'PUT') return json({ etag: '"v1"' });
    if (req.url.pathname.endsWith('/file') && req.method === 'GET') return new Response('hi', { headers: { etag: '"v1"' } });
    if (req.url.pathname.endsWith('/state')) return json({ cursor: 'c' });
    if (req.url.pathname.endsWith('/stat')) return json({ entry: { path: 'a.md', kind: 'file' } });
    if (req.url.pathname.endsWith('/mkdir')) return json({ changed: true });
    return json({ ok: true });
  };

  it('is sent on that path’s write, rename (by its from) and remove, and on nothing else', async () => {
    handler = okAll;
    const store = make();
    store.setContext('a.md', 'orbit:card/b/1');
    await store.write('a.md', 'x');
    await store.write('other.md', 'x');
    await store.rename('a.md', 'b.md'); // from is a.md
    await store.rename('c.md', 'a.md'); // `to` doesn't carry it
    store.setContext('a.md', 'orbit:card/b/1');
    await store.remove('a.md');
    await store.readText('a.md');
    await store.stat('a.md');
    await store.readBlob('a.md');
    await store.mkdir('a.md');
    await store.list().catch(() => {});

    expect(calls.map((c) => [c.method, c.url.pathname.split('/').pop(), c.url.searchParams.get('path') ?? c.url.searchParams.get('from'), header(c)])).toEqual([
      ['PUT', 'file', 'a.md', 'orbit:card/b/1'],
      ['PUT', 'file', 'other.md', null],
      ['POST', 'rename', 'a.md', 'orbit:card/b/1'],
      ['POST', 'rename', 'c.md', null],
      ['DELETE', 'file', 'a.md', 'orbit:card/b/1'],
      ['GET', 'file', 'a.md', null],
      ['GET', 'stat', 'a.md', null],
      ['GET', 'file', 'a.md', null],
      ['POST', 'mkdir', 'a.md', null],
      ['GET', 'list', null, null],
    ]);
  });

  it('a link the server’s rule refuses is never kept, and 256 characters pass', async () => {
    handler = okAll;
    const store = make();
    const heard = vi.fn();
    store.onContext(heard);
    store.setContext('a.md', 'orbit:card/with space/1');
    store.setContext('a.md', `orbit:card/${'x'.repeat(246)}`); // 257
    store.setContext('a.md', '');
    expect(store.contextOf('a.md')).toBeUndefined();
    expect(heard).not.toHaveBeenCalled();
    const longest = `orbit:card/${'x'.repeat(245)}`; // 256
    expect(longest).toHaveLength(256);
    store.setContext('a.md', longest);
    await store.write('a.md', 'x');
    expect(header(calls[0])).toBe(longest);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('a refused link also drops the card named before it, so nothing stale is sent', async () => {
    handler = okAll;
    const store = make();
    store.setContext('a.md', 'orbit:card/b/1');
    store.setContext('a.md', 'not a link');
    await store.write('a.md', 'x');
    expect(header(calls[0])).toBeNull();
  });

  it('a rename made here moves it to the new path, and under a renamed folder', async () => {
    handler = okAll;
    const store = make();
    store.setContext('a.md', 'orbit:card/b/1');
    store.setContext('Notes/deep/x.md', 'orbit:card/b/2');
    await store.rename('a.md', 'b.md');
    await store.rename('Notes', 'Journal');
    expect(store.contextOf('a.md')).toBeUndefined();
    expect(store.contextOf('b.md')).toBe('orbit:card/b/1');
    expect(store.contextOf('Notes/deep/x.md')).toBeUndefined();
    expect(store.contextOf('Journal/deep/x.md')).toBe('orbit:card/b/2');
    calls = [];
    await store.write('b.md', 'x');
    await store.write('Journal/deep/x.md', 'x');
    await store.write('a.md', 'x');
    expect(calls.map(header)).toEqual(['orbit:card/b/1', 'orbit:card/b/2', null]);
  });

  it('a rename of a folder whose name only starts the same leaves the others alone', async () => {
    handler = okAll;
    const store = make();
    store.setContext('Notes2/x.md', 'orbit:card/b/3');
    await store.rename('Notes', 'Journal');
    expect(store.contextOf('Notes2/x.md')).toBe('orbit:card/b/3');
  });

  it('null clears it, and onContext hears each change and no repeat', async () => {
    handler = okAll;
    const store = make();
    const heard = vi.fn();
    const stop = store.onContext(heard);
    store.setContext('a.md', 'orbit:card/b/1');
    store.setContext('a.md', 'orbit:card/b/1'); // nothing changed
    store.setContext('a.md', 'orbit:card/b/2');
    store.setContext('a.md', null);
    store.setContext('a.md', null); // nothing to clear
    expect(heard).toHaveBeenCalledTimes(3);
    await store.write('a.md', 'x');
    expect(header(calls[0])).toBeNull();
    await store.rename('a.md', 'z.md'); // a move with nothing to move says nothing
    expect(heard).toHaveBeenCalledTimes(3);
    stop();
    store.setContext('a.md', 'orbit:card/b/9');
    expect(heard).toHaveBeenCalledTimes(3);
  });
});

describe('space()', () => {
  it('reads space from the place with the store’s own base and api', async () => {
    handler = (req) =>
      req.url.pathname === '/mount/api/place'
        ? json({ place: { tier: 'server', label: 'vps', url: ORIGIN }, projects: [], space: { used: 120, limit: 1000, upgrade: 'https://suite.test/plans' } })
        : json({ error: 'wrong address' }, 404);
    const store = make({ api: '/mount/api' });
    expect(await store.space()).toEqual({ used: 120, limit: 1000, upgrade: 'https://suite.test/plans' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.origin + calls[0].url.pathname).toBe(`${ORIGIN}/mount/api/place`);
  });

  it('is undefined when the place sends none, or can’t be asked', async () => {
    handler = () => json({ place: { tier: 'server', label: 'vps', url: ORIGIN }, projects: [] });
    expect(await make().space()).toBeUndefined();
    handler = () => Promise.reject(new TypeError('network'));
    expect(await make().space()).toBeUndefined();
  });
});

describe('the history calls', () => {
  const page = { versions: [{ version: 'v2', at: '2026-11-21T10:00:00.000Z', size: 3, current: true, path: 'a.md' }], next: null };

  it('versions asks for the path and only the options given, and returns the page as given', async () => {
    handler = () => json(page);
    const store = make();
    expect(await store.versions('Notes/a b.md')).toEqual(page);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url.pathname).toBe(`${API}/projects/p1/versions`);
    expect([...calls[0].url.searchParams]).toEqual([['path', 'Notes/a b.md']]);
    await store.versions('a.md', { before: 'cur9', limit: 20 });
    expect(Object.fromEntries(calls[1].url.searchParams)).toEqual({ path: 'a.md', before: 'cur9', limit: '20' });
    await store.versions('a.md', { limit: 5 });
    expect(Object.fromEntries(calls[2].url.searchParams)).toEqual({ path: 'a.md', limit: '5' });
  });

  it('versions turns a 404 into FileNotFoundError and a 405 into a not-supported ServerError', async () => {
    const store = make();
    handler = () => json({ error: 'not-found' }, 404);
    await expect(store.versions('a.md')).rejects.toBeInstanceOf(FileNotFoundError);
    handler = () => json({ error: 'not-supported', message: 'No versions here' }, 405);
    await expect(store.versions('a.md')).rejects.toMatchObject({ name: 'ServerError', status: 405, code: 'not-supported' });
  });

  it('versions meeting a signed-out session says so', async () => {
    handler = () => bodiless(401);
    await expect(make().versions('a.md')).rejects.toBeInstanceOf(SignedOutError);
  });

  it('readVersion asks for the path and version, returns the bytes, and leaves what the store knows alone', async () => {
    handler = (req) => {
      if (req.url.pathname.endsWith('/version')) return new Response(new Uint8Array([1, 2, 3]), { headers: { etag: '"old"' } });
      if (req.method === 'GET') return new Response('now', { headers: { etag: '"v2"' } });
      return json({ etag: '"v3"' });
    };
    const store = make();
    await store.readText('a.md'); // known: v2 holding 'now'
    const blob = await store.readVersion('a.md', 'v1');
    expect(Array.from(new Uint8Array(await new Response(blob).arrayBuffer()))).toEqual([1, 2, 3]);
    const version = calls.find((c) => c.url.pathname.endsWith('/version'))!;
    expect(Object.fromEntries(version.url.searchParams)).toEqual({ path: 'a.md', version: 'v1' });

    calls = [];
    await store.write('a.md', 'next', { ifUnchanged: { text: 'now' } });
    expect(calls).toHaveLength(1); // no re-read: the known version is still the file's
    expect(calls[0].headers.get('if-match')).toBe('"v2"');
  });

  it('readVersion of a version no longer kept is FileNotFoundError', async () => {
    handler = () => json({ error: 'not-found' }, 404);
    await expect(make().readVersion('a.md', 'gone')).rejects.toBeInstanceOf(FileNotFoundError);
  });

  describe('restore', () => {
    const entry = { path: 'a.md', kind: 'file', size: 3 };

    it('sends the version in the query and If-Match quoted, whether it was given bare or quoted', async () => {
      handler = () => json({ entry, etag: '"v3"' });
      const store = make();
      await store.restore('a.md', 'v1', { ifMatch: 'v2' });
      await store.restore('a.md', 'v1', { ifMatch: '"v2"' });
      for (const call of calls) {
        expect(call.method).toBe('POST');
        expect(call.url.pathname).toBe(`${API}/projects/p1/restore`);
        expect(Object.fromEntries(call.url.searchParams)).toEqual({ path: 'a.md', version: 'v1' });
        expect(call.headers.get('if-match')).toBe('"v2"');
        expect(call.headers.get('if-none-match')).toBeNull();
      }
    });

    it('ifAbsent sends If-None-Match: * and no If-Match', async () => {
      handler = () => json({ entry, etag: '"v3"' });
      await make().restore('a.md', 'v1', { ifAbsent: true });
      expect(calls[0].headers.get('if-none-match')).toBe('*');
      expect(calls[0].headers.get('if-match')).toBeNull();
    });

    it('answers the entry, and the version the store knows becomes the answer’s etag', async () => {
      handler = (req) => {
        if (req.url.pathname.endsWith('/restore')) return json({ entry, etag: '"v3"' });
        if (req.method === 'GET') return new Response('restored', { headers: { etag: '"v3"' } });
        return json({ etag: '"v4"' });
      };
      const store = make();
      expect(await store.restore('a.md', 'v1', { ifMatch: 'v2' })).toEqual(entry);
      // Never read here, yet the store knows the file now: its next write names the parents as existing.
      calls = [];
      await store.write('a.md', 'x');
      expect(calls[0].headers.get('nebula-parents')).toBe('existing');
    });

    it('a save after a restore with the restored text meets no stale version', async () => {
      const seen: string[] = [];
      handler = (req) => {
        if (req.url.pathname.endsWith('/restore')) return json({ entry, etag: '"v3"' });
        if (req.method === 'GET') return new Response('restored', { headers: { etag: '"v3"' } });
        seen.push(req.headers.get('if-match') ?? '');
        return json({ etag: '"v4"' });
      };
      const store = make();
      await store.readText('a.md').catch(() => {}); // learns the file at a version the restore then replaces
      handler = (req) => {
        if (req.url.pathname.endsWith('/restore')) return json({ entry, etag: '"v3"' });
        if (req.method === 'GET') return new Response('restored', { headers: { etag: '"v3"' } });
        seen.push(req.headers.get('if-match') ?? '');
        return json({ etag: '"v4"' });
      };
      await store.restore('a.md', 'v1', { ifMatch: 'v2' });
      await store.write('a.md', 'next', { ifUnchanged: { text: 'restored' } });
      expect(seen).toEqual(['"v3"']);
    });

    it('does not trust the text it held before the restore', async () => {
      let served = 'old';
      handler = (req) => {
        if (req.url.pathname.endsWith('/restore')) {
          served = 'restored';
          return json({ entry, etag: '"v3"' });
        }
        if (req.method === 'GET') return new Response(served, { headers: { etag: served === 'old' ? '"v2"' : '"v3"' } });
        return json({ etag: '"v4"' });
      };
      const store = make();
      await store.readText('a.md');
      await store.restore('a.md', 'v1', { ifMatch: 'v2' });
      calls = [];
      // The old text is no longer the file's: the save is refused, with nothing sent over "v2".
      await expect(store.write('a.md', 'mine', { ifUnchanged: { text: 'old' } })).rejects.toBeInstanceOf(FileChangedError);
      expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    });

    it('its watchers hear the write once; the feed’s echo of this tab’s own change is skipped', async () => {
      vi.useFakeTimers();
      const s = stream();
      let client = '';
      handler = (req) => {
        if (req.url.pathname.endsWith('/events')) {
          client = req.headers.get('nebula-client') ?? '';
          return s.response;
        }
        return json({ entry, etag: '"v3"' });
      };
      const store = make();
      const heard: FileChange[] = [];
      store.watch((change) => heard.push(change));
      await vi.advanceTimersByTimeAsync(10);
      await store.restore('a.md', 'v1', { ifMatch: 'v2' });
      expect(heard).toEqual([{ type: 'write', path: 'a.md' }]);
      s.send(`id: c1\nevent: change\ndata: ${JSON.stringify({ change: { type: 'write', path: 'a.md' }, by: client })}\n\n`);
      await vi.advanceTimersByTimeAsync(10);
      expect(client).not.toBe('');
      expect(heard).toHaveLength(1);
      // Another client's change to the same path is news.
      s.send(`id: c2\nevent: change\ndata: ${JSON.stringify({ change: { type: 'write', path: 'a.md' }, by: 'someone-else' })}\n\n`);
      await vi.advanceTimersByTimeAsync(10);
      expect(heard).toHaveLength(2);
    });

    it('a 412 is FileChangedError (absent when the problem says so) and emits nothing', async () => {
      const store = make();
      const heard: FileChange[] = [];
      store.watch((change) => heard.push(change));
      handler = () => json({ error: 'changed' }, 412);
      const changed = await store.restore('a.md', 'v1', { ifMatch: 'v2' }).catch((e: unknown) => e);
      expect(changed).toBeInstanceOf(FileChangedError);
      expect((changed as FileChangedError).absent).toBe(false);
      handler = () => json({ error: 'changed', absent: true }, 412);
      const gone = await store.restore('a.md', 'v1', { ifMatch: 'v2' }).catch((e: unknown) => e);
      expect(gone).toBeInstanceOf(FileChangedError);
      expect((gone as FileChangedError).absent).toBe(true);
      expect(heard.filter((c) => c.type === 'write')).toEqual([]);
    });

    it('queues behind a write in flight', async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => void (release = resolve));
      handler = async (req) => {
        if (req.method === 'PUT') {
          await held;
          return json({ etag: '"v2"' });
        }
        return json({ entry, etag: '"v3"' });
      };
      const store = make();
      const write = store.write('a.md', 'x');
      const restore = store.restore('a.md', 'v1', { ifMatch: 'v2' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls.map((c) => c.method)).toEqual(['PUT']);
      release();
      await Promise.all([write, restore]);
      expect(calls.map((c) => c.method)).toEqual(['PUT', 'POST']);
    });

    it('other refusals keep their meaning: signed out, and a version that is gone', async () => {
      const store = make();
      handler = () => json({ error: 'not-found' }, 404);
      await expect(store.restore('a.md', 'v1', { ifMatch: 'v2' })).rejects.toBeInstanceOf(FileNotFoundError);
      handler = () => bodiless(401);
      await expect(store.restore('a.md', 'v1', { ifMatch: 'v2' })).rejects.toBeInstanceOf(SignedOutError);
    });
  });

  describe('changes', () => {
    it('asks the API’s root, not the project’s, with the project id encoded, and returns the changes', async () => {
      const records = [{ seq: 1, cursor: 'c1', at: '2026-11-21T10:00:00.000Z', project: 'p 1', type: 'write', path: 'a.md' }];
      handler = () => json({ changes: records });
      const store = make({ projectId: 'p 1' });
      expect(await store.changes('Notes/a.md', { limit: 30 })).toEqual(records);
      expect(calls[0].method).toBe('GET');
      expect(calls[0].url.origin + calls[0].url.pathname).toBe(`${ORIGIN}${API}/changes`);
      expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ project: 'p 1', path: 'Notes/a.md', limit: '30' });
      expect(calls[0].url.search).toContain('project=p+1');
      await store.changes('a.md');
      expect(calls[1].url.searchParams.has('limit')).toBe(false);
    });

    it('an unreachable server is ServerUnreachableError, and a 401 is signed out', async () => {
      const store = make();
      handler = () => Promise.reject(new TypeError('network'));
      await expect(store.changes('a.md')).rejects.toBeInstanceOf(ServerUnreachableError);
      handler = () => bodiless(401);
      await expect(store.changes('a.md')).rejects.toBeInstanceOf(SignedOutError);
    });
  });
});
