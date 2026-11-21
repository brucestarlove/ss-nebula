/**
 * The server tier: a project that is a real folder on a
 * computer or a server, reached through a Nebula server on the same origin
 * as the app (cli/nebula-files.mjs). Each store is one project.
 *
 * What it keeps of the store contract every remote tier keeps: every read and write carries the file's version (an ETag), so
 * `exclusive` and `ifUnchanged` become `If-None-Match: *` and `If-Match`, and
 * the server checks them and writes as one step; writes land whole; the
 * change feed is Server-Sent Events read through fetch, resumed from a cursor
 * after a drop, and a drop longer than a moment says `unreachable` (nothing in
 * the project is gone) until it's back.
 *
 * Changes this store made are told to its watchers as each completes, as the
 * other stores do; the feed's echo of them (marked with this store's client
 * id) is skipped. Mutations run in the order they were asked for, so a rename
 * waits for a write in flight before it.
 *
 * A session that has ended (401) and an account out of space (507) are facts about the person,
 * not the server: SignedOutError and SpaceFullError, for reads and writes alike. The feed stops
 * retrying while signed out (a refused reconnect would only repeat itself), the store says so to
 * `onAccount` listeners, never as a FileChange, and takes the feed up again from its cursor once
 * a request is answered. The frame can also pause the feed (a hidden frame holds no connection)
 * and resume it from the cursor; that is the app's choice, never shown as an outage.
 */
import { blobToText } from './bytes';
import { registerOpenStore, type AccountStatus } from './account';
import { isContextLink } from './contextLink';
import { EntryTypeError, FileChangedError, FileExistsError, FileNotFoundError, FolderTooBigError } from './errors';
import { ChangeListeners } from './listeners';
import { formatBytes } from './persist';
import { addServerPlace, type Home } from './places';
import { comparePaths, isInside, normalizePath } from './paths';
import type { Actor, FileChange, FileEntry, FileStore, ProjectMeta, WriteOptions } from './types';
import type { SpaceInfo, VersionsPage } from './serverContract';
import type { ChangeRecord, DeletedFilesPage, HistoryStore, RestoreCondition } from './history';

/** Where the API is unless the server's mark names another base (src/app/serverTier.ts). */
export const SERVER_API = '/nebula-api/v1';

/** Where a server says it is (Orbit's places note, point 4). */
export type ServerPlace = { tier: 'server'; label: string; url: string };

/** A project as the server lists it: its meta, and its folder's name there
 * when the server keeps its projects as folders. The memory and database
 * backends (the Suite, `nebula run --database`) have no folder to name. */
export type ServerProject = ProjectMeta & { folder?: string };

/** What `GET <api>/place` answers: where the server is, its projects, the
 * homes its host offers (every one when it doesn't say, as a 2.0.2 server
 * doesn't), the host's scope for what this device notes about its projects,
 * and whether it makes projects. */
export type ServerInfo = {
  place: ServerPlace;
  projects: ServerProject[];
  homes?: Home[];
  scope?: string;
  /** Who is asking, as the server's records name them: the app says "you" for these. */
  you?: Actor;
  /** The account's space, when the host sets an allowance. */
  space?: SpaceInfo;
  capabilities?: { createProject?: boolean; versions?: boolean; removeProject?: boolean; deletedFiles?: boolean };
};

type FetchLike = typeof fetch;

/** Something went wrong between the browser and the server: not a fact about the file. */
export class ServerUnreachableError extends Error {
  constructor(label: string, cause?: unknown) {
    super(`Nebula can’t reach ‘${label}’ right now`);
    this.name = 'ServerUnreachableError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** A server's answer Nebula didn't expect. */
export class ServerError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ServerError';
    this.status = status;
    this.code = code;
  }
}

/** The session ended (401): nothing is wrong with the file or the server. The edit that met it is
 * still held where it was made; `signIn` is where the host signs people in, when it says. */
export class SignedOutError extends Error {
  readonly signIn?: string;
  constructor(options: { signIn?: string; message?: string } = {}) {
    super(options.message || 'You’re signed out. Your changes are kept here until you sign in again.');
    this.name = 'SignedOutError';
    if (options.signIn) this.signIn = options.signIn;
  }
}

/** A write that would pass the account's allowance (507). Removing, renaming and trimming still pass. */
export class SpaceFullError extends Error {
  readonly used: number;
  readonly limit: number;
  readonly upgrade?: string;
  constructor(options: { used?: unknown; limit?: unknown; upgrade?: string; message?: string } = {}) {
    const used = typeof options.used === 'number' && Number.isFinite(options.used) ? options.used : 0;
    const limit = typeof options.limit === 'number' && Number.isFinite(options.limit) ? options.limit : 0;
    super(options.message || (limit > 0 ? `Your space is full (${formatBytes(used)} of ${formatBytes(limit)}).` : 'Your space is full.'));
    this.name = 'SpaceFullError';
    this.used = used;
    this.limit = limit;
    if (options.upgrade) this.upgrade = options.upgrade;
  }
}

type Problem = {
  error?: string;
  message?: string;
  exists?: boolean;
  absent?: boolean;
  expected?: 'file' | 'folder';
  signIn?: string;
  used?: number;
  limit?: number;
  upgrade?: string;
};

/** Sign-in places signed-out stores watch for the person's return: the tab regaining focus. */
const signedOutStores = new Set<HttpFileStore>();
let leaving: (() => void) | null = null;

function listenForReturn(): void {
  if (leaving || typeof window === 'undefined' || typeof document === 'undefined') return;
  const back = () => {
    if (document.visibilityState === 'hidden') return;
    for (const store of [...signedOutStores]) void store.retryAccount();
  };
  window.addEventListener('focus', back);
  document.addEventListener('visibilitychange', back);
  leaving = () => {
    window.removeEventListener('focus', back);
    document.removeEventListener('visibilitychange', back);
  };
}

function stopListeningForReturn(): void {
  if (signedOutStores.size > 0) return;
  leaving?.();
  leaving = null;
}

function clientId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isServerInfo(value: unknown): value is ServerInfo {
  const info = value as ServerInfo | null;
  return (
    typeof info === 'object' && info !== null &&
    info.place?.tier === 'server' && typeof info.place.label === 'string' && typeof info.place.url === 'string' &&
    Array.isArray(info.projects) && info.projects.every((p) => typeof p?.id === 'string' && typeof p.name === 'string')
  );
}

/** The server's place and projects, or null when there is no server tier here. */
export async function fetchServerInfo(options: { base?: string; api?: string; fetch?: FetchLike } = {}): Promise<ServerInfo | null> {
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(`${options.base ?? ''}${options.api ?? SERVER_API}/place`, { headers: { accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('application/json')) return null;
    const info: unknown = await response.json();
    return isServerInfo(info) ? info : null;
  } catch {
    return null;
  }
}

export type HttpFileStoreOptions = {
  projectId: string;
  /** What the server calls itself, for messages: 'vps-starscape'. */
  label: string;
  /** The origin's prefix: '' on the same origin (the app's case), or a URL in tests. */
  base?: string;
  /** The API's path, as the server's mark names it: SERVER_API unless a host mounts it elsewhere. */
  api?: string;
  fetch?: FetchLike;
  /** The change cursor to resume from; open() reads it, so nothing made after it is missed. */
  cursor?: string;
  /** How long the feed may be down before watchers hear `unreachable`. */
  graceMs?: number;
};

/** What `HttpFileStore.space()` and the like need of the origin: the place's address. */
type PlaceAddress = { base?: string; api?: string };

type Known = { etag: string; text?: string };

export class HttpFileStore implements FileStore, HistoryStore {
  readonly projectId: string;
  readonly label: string;
  private readonly base: string;
  private readonly doFetch: FetchLike;
  private readonly client = clientId();
  private readonly listeners = new ChangeListeners();
  /** Files this store has read or written, with their version: a write to one
   * never brings back a folder someone else removed (R4). */
  private readonly known = new Map<string, Known>();
  private queue: Promise<unknown> = Promise.resolve();
  private cursor: string | undefined;
  private readonly graceMs: number;
  private feed: AbortController | null = null;
  private down = false;
  private downTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly address: PlaceAddress;
  /** The app let go of the feed (the frame is hidden): not an outage, nothing is said of it. */
  private paused = false;
  /** The session has ended: the feed stays stopped until a request is answered. */
  private ended = false;
  private signIn: string | undefined;
  private closed = false;
  private readonly accountListeners = new Set<(status: AccountStatus) => void>();
  /** The link this tab's writes to a path name (`orbit:card/…`), never kept on the device. */
  private readonly contexts = new Map<string, string>();
  private readonly contextListeners = new Set<() => void>();
  private readonly unregister: () => void;

  constructor(options: HttpFileStoreOptions) {
    this.projectId = options.projectId;
    this.label = options.label;
    this.base = `${options.base ?? ''}${options.api ?? SERVER_API}/projects/${encodeURIComponent(options.projectId)}`;
    this.doFetch = options.fetch ?? fetch.bind(globalThis);
    this.cursor = options.cursor;
    this.graceMs = options.graceMs ?? 3_000;
    this.address = { base: options.base, api: options.api };
    this.unregister = registerOpenStore(this);
    addServerPlace(options.label);
  }

  /** A store whose feed starts from now: what the server says the cursor is. */
  static async open(options: HttpFileStoreOptions): Promise<HttpFileStore> {
    const store = new HttpFileStore(options);
    const state = (await store.json('GET', 'state')) as { cursor: string };
    store.cursor = state.cursor;
    return store;
  }

  // --- requests --------------------------------------------------------------

  private url(action: string, params: Record<string, string> = {}): string {
    const query = new URLSearchParams(params).toString();
    return `${this.base}/${action}${query ? `?${query}` : ''}`;
  }

  private async request(method: string, action: string, params: Record<string, string> = {}, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.doFetch(this.url(action, params), {
        ...init,
        method,
        cache: 'no-store',
        headers: { 'nebula-client': this.client, ...(init.headers as Record<string, string> | undefined) },
      });
    } catch (error) {
      throw new ServerUnreachableError(this.label, error);
    }
    // A sign-in page the host redirects to is no answer from the server.
    if (response.ok && this.ended && !response.redirected) this.signedBackIn();
    return response;
  }

  private async problem(response: Response): Promise<Problem> {
    try {
      return (await response.json()) as Problem;
    } catch {
      return {};
    }
  }

  /** The error a refused answer means, for a path. */
  private async failure(response: Response, path: string): Promise<Error> {
    const problem = await this.problem(response);
    // Any 401 is the session: a host may answer without a body, or in its own words.
    if (response.status === 401 || problem.error === 'signed-out') {
      this.signedOutNow(problem.signIn);
      return new SignedOutError({ signIn: problem.signIn ?? this.signIn, message: problem.message });
    }
    switch (problem.error) {
      case 'space-full':
        return new SpaceFullError({ used: problem.used, limit: problem.limit, upgrade: problem.upgrade, message: problem.message });
      case 'not-found':
        return new FileNotFoundError(path);
      case 'exists':
        return new FileExistsError(path);
      case 'type':
        return new EntryTypeError(path, problem.expected ?? 'file');
      case 'too-big':
        return new FolderTooBigError(this.label, 20_000);
      default:
        if (response.status >= 500 && response.status !== 507) return new ServerUnreachableError(this.label);
        return new ServerError(response.status, problem.error ?? 'unknown', problem.message ?? `The server answered ${response.status}`);
    }
  }

  private async json(method: string, action: string, params: Record<string, string> = {}, path = ''): Promise<unknown> {
    const response = await this.request(method, action, params, { headers: { accept: 'application/json' } });
    if (!response.ok) throw await this.failure(response, path);
    return response.json();
  }

  /** Mutations in the order they were asked for. */
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action, action);
    this.queue = result.catch(() => {});
    return result;
  }

  // --- FileStore -------------------------------------------------------------

  async list(): Promise<FileEntry[]> {
    const { entries } = (await this.json('GET', 'list')) as { entries: FileEntry[] };
    return entries.sort((a, b) => comparePaths(a.path, b.path));
  }

  async stat(path: string): Promise<FileEntry | null> {
    normalizePath(path);
    const response = await this.request('GET', 'stat', { path }, { headers: { accept: 'application/json' } });
    if (response.status === 404) return null;
    if (!response.ok) throw await this.failure(response, path);
    return ((await response.json()) as { entry: FileEntry }).entry;
  }

  private async fetchFile(path: string): Promise<{ blob: Blob; etag: string }> {
    normalizePath(path);
    const response = await this.request('GET', 'file', { path });
    if (!response.ok) throw await this.failure(response, path);
    const etag = response.headers.get('etag') ?? '';
    return { blob: await response.blob(), etag };
  }

  async readText(path: string): Promise<string> {
    const { blob, etag } = await this.fetchFile(path);
    const text = await blobToText(blob);
    this.known.set(path, { etag, text });
    return text;
  }

  async readBlob(path: string): Promise<Blob> {
    const { blob, etag } = await this.fetchFile(path);
    this.known.set(path, { etag });
    return blob;
  }

  // Async, so a bad path rejects like every other refusal; the queue is still
  // joined before the first await, in the order the calls were made.
  async write(path: string, data: string | Blob, options: WriteOptions = {}): Promise<void> {
    normalizePath(path);
    return this.serial(async () => {
      const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
      const expected = options.ifUnchanged;
      if (options.exclusive || expected === 'absent') headers['if-none-match'] = '*';
      else if (expected) headers['if-match'] = await this.versionHolding(path, expected.text);
      if (this.known.has(path)) headers['nebula-parents'] = 'existing';
      Object.assign(headers, this.contextHeaders(path));
      const response = await this.request('PUT', 'file', { path }, { body: data, headers });
      if (response.status === 412) {
        const problem = await this.problem(response);
        if (options.exclusive) throw new FileExistsError(path);
        throw new FileChangedError(path, problem.absent === true);
      }
      if (!response.ok) throw await this.failure(response, path);
      const { etag } = (await response.json()) as { etag: string };
      this.known.set(path, typeof data === 'string' ? { etag, text: data } : { etag });
      this.listeners.emit({ type: 'write', path });
    });
  }

  /** The version of `path` that holds exactly `text`, for If-Match; or
   * FileChangedError. The text is compared, not sizes or times;
   * the server then writes only over that very version. */
  private async versionHolding(path: string, text: string): Promise<string> {
    const known = this.known.get(path);
    if (known?.text === text) return known.etag;
    let current: { blob: Blob; etag: string };
    try {
      current = await this.fetchFile(path);
    } catch (error) {
      if (error instanceof FileNotFoundError || error instanceof EntryTypeError) throw new FileChangedError(path, true);
      throw error;
    }
    if ((await blobToText(current.blob)) !== text) throw new FileChangedError(path);
    return current.etag;
  }

  async mkdir(path: string): Promise<void> {
    normalizePath(path);
    return this.serial(async () => {
      const response = await this.request('POST', 'mkdir', { path });
      if (!response.ok) throw await this.failure(response, path);
      const { changed } = (await response.json()) as { changed: boolean };
      if (changed) this.listeners.emit({ type: 'mkdir', path });
    });
  }

  async rename(from: string, to: string): Promise<void> {
    normalizePath(from);
    normalizePath(to);
    return this.serial(async () => {
      const response = await this.request('POST', 'rename', { from, to }, { headers: this.contextHeaders(from) });
      if (!response.ok) throw await this.failure(response, response.status === 404 ? from : to);
      this.forget(from, to);
      this.moveContexts(from, to);
      this.listeners.emit({ type: 'rename', from, to });
    });
  }

  async remove(path: string): Promise<void> {
    normalizePath(path);
    return this.serial(async () => {
      const response = await this.request('DELETE', 'file', { path }, { headers: this.contextHeaders(path) });
      if (!response.ok) throw await this.failure(response, path);
      this.forget(path);
      this.listeners.emit({ type: 'remove', path });
    });
  }

  /** What this store knows of `path` and everything in it goes, or moves to `to`. */
  private forget(path: string, to?: string): void {
    for (const [known, version] of [...this.known]) {
      if (!isInside(known, path)) continue;
      this.known.delete(known);
      if (to !== undefined) this.known.set(to + known.slice(path.length), version);
    }
  }

  watch(listener: (change: FileChange) => void): () => void {
    const stop = this.listeners.add(listener);
    this.syncFeed();
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      stop();
      this.syncFeed();
    };
  }

  // --- the account, pausing, and the card's context ---------------------------------------------

  /** Told when the session ends and when it's back. */
  onAccount(listener: (status: AccountStatus) => void): () => void {
    this.accountListeners.add(listener);
    return () => {
      this.accountListeners.delete(listener);
    };
  }

  /** Whether the session has ended, and where the host signs people in, if it said. */
  signedOut(): { signIn?: string } | null {
    return this.ended ? (this.signIn ? { signIn: this.signIn } : {}) : null;
  }

  /** Looks again while signed out: the first answer says `signed-in` and the feed carries on from
   * its cursor. A refusal says nothing new; an unreachable server says nothing at all. */
  async retryAccount(): Promise<void> {
    if (!this.ended || this.closed) return;
    try {
      const response = await this.request('GET', 'state', {}, { headers: { accept: 'application/json' } });
      if (!response.ok) await this.failure(response, '');
    } catch {
      // Still out of reach: the next focus or Try again looks again.
    }
  }

  private signedOutNow(signIn?: string): void {
    if (signIn) this.signIn = signIn;
    if (this.ended) return;
    this.ended = true;
    // The server answered, so it's not an outage: whatever the feed had said of one ends here.
    this.cameBack(false);
    this.syncFeed();
    signedOutStores.add(this);
    listenForReturn();
    for (const listener of [...this.accountListeners]) listener('signed-out');
  }

  private signedBackIn(): void {
    if (!this.ended) return;
    this.ended = false;
    this.signIn = undefined;
    signedOutStores.delete(this);
    stopListeningForReturn();
    this.syncFeed();
    for (const listener of [...this.accountListeners]) listener('signed-in');
  }

  /** The app lets go of the live feed (a hidden frame holds no connection all day). Nothing is
   * said to watchers: this is a choice, not an outage. */
  pause(): void {
    this.paused = true;
    this.syncFeed();
  }

  /** Takes the feed up again from the cursor this store holds, so nothing made meanwhile is missed. */
  resume(): void {
    this.paused = false;
    this.syncFeed();
  }

  /** Lets go of the feed for good; the store is out of the set the frame pauses. */
  close(): void {
    this.closed = true;
    signedOutStores.delete(this);
    stopListeningForReturn();
    this.syncFeed();
    this.unregister();
  }

  /** The account's space as the place says it now (`GET <api>/place`), for Settings; undefined when
   * it says none or can't be asked. */
  async space(): Promise<SpaceInfo | undefined> {
    const info = await fetchServerInfo({ ...this.address, fetch: this.doFetch });
    return info?.space;
  }

  /** From now on this tab's writes, renames and removes of `path` name `context` (an Orbit card's
   * link), until it's null. A value the server would refuse is never kept. */
  setContext(path: string, context: string | null): void {
    if (context === null || !isContextLink(context)) {
      if (!this.contexts.delete(path)) return;
    } else {
      if (this.contexts.get(path) === context) return;
      this.contexts.set(path, context);
    }
    for (const listener of [...this.contextListeners]) listener();
  }

  contextOf(path: string): string | undefined {
    return this.contexts.get(path);
  }

  onContext(listener: () => void): () => void {
    this.contextListeners.add(listener);
    return () => {
      this.contextListeners.delete(listener);
    };
  }

  /** The header a change to `path` carries when this tab was given a context for it. */
  private contextHeaders(path: string): Record<string, string> {
    const context = this.contexts.get(path);
    return context ? { 'nebula-context': context } : {};
  }

  /** A rename made here takes the context with the file (or with every file inside a folder). */
  private moveContexts(from: string, to: string): void {
    let moved = false;
    for (const [path, context] of [...this.contexts]) {
      if (!isInside(path, from)) continue;
      this.contexts.delete(path);
      this.contexts.set(to + path.slice(from.length), context);
      moved = true;
    }
    if (moved) for (const listener of [...this.contextListeners]) listener();
  }

  // --- the change feed -------------------------------------------------------

  private startFeed(): void {
    const controller = new AbortController();
    this.feed = controller;
    void this.runFeed(controller.signal);
  }

  /** The feed runs while someone watches, the app hasn't paused it, and the session is good. */
  private syncFeed(): void {
    const wanted = this.listeners.size > 0 && !this.paused && !this.ended && !this.closed;
    if (wanted && !this.feed) this.startFeed();
    else if (!wanted && this.feed) this.stopFeed();
  }

  private stopFeed(): void {
    this.feed?.abort();
    this.feed = null;
    if (this.downTimer) clearTimeout(this.downTimer);
    this.downTimer = null;
  }

  private wentDown(): void {
    if (this.down || this.downTimer) return;
    this.downTimer = setTimeout(() => {
      this.downTimer = null;
      this.down = true;
      this.listeners.emit({ type: 'unreachable', folder: this.label });
    }, this.graceMs);
  }

  private cameBack(resynced: boolean): void {
    if (this.downTimer) {
      clearTimeout(this.downTimer);
      this.downTimer = null;
      // Back within the grace, with nothing missed: nothing to say.
      if (!resynced) return;
    }
    if (!this.down && resynced) this.listeners.emit({ type: 'unreachable', folder: this.label });
    if (this.down || resynced) this.listeners.emit({ type: 'reachable' });
    this.down = false;
  }

  private async runFeed(signal: AbortSignal): Promise<void> {
    let delay = 1_000;
    // Picked up again while the project was said to be unreachable: coming back is news.
    let first = !this.down;
    while (!signal.aborted) {
      try {
        const params: Record<string, string> = this.cursor ? { since: this.cursor } : {};
        const response = await this.doFetch(this.url('events', params), { headers: { accept: 'text/event-stream', 'nebula-client': this.client }, cache: 'no-store', signal });
        if (response.status === 401) {
          // No outage, and no use retrying: the feed stops until a request is answered.
          this.signedOutNow((await this.problem(response)).signIn);
          return;
        }
        if (!response.ok || !response.body) throw new Error(`events: ${response.status}`);
        let resynced = false;
        await this.readEvents(response.body, signal, (event, data, id) => {
          if (id) this.cursor = id;
          if (event === 'resync') resynced = true;
          else if (event === 'ready') {
            if (!first || resynced) this.cameBack(resynced);
            first = false;
            delay = 1_000;
          } else if (event === 'change') this.heard(data);
        });
      } catch {
        // dropped, refused or aborted
      }
      if (signal.aborted) return;
      this.wentDown();
      first = false;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 10_000);
    }
  }

  private heard(data: string): void {
    let message: { change?: FileChange; by?: string | null };
    try {
      message = JSON.parse(data) as typeof message;
    } catch {
      return;
    }
    const change = message.change;
    if (!change || message.by === this.client) return;
    if (change.type === 'remove') this.forget(change.path);
    else if (change.type === 'rename') this.forget(change.from, change.to);
    // Still a file this store knows (its folder isn't brought back), at a version it hasn't seen.
    else if (change.type === 'write' && this.known.has(change.path)) this.known.set(change.path, { etag: '' });
    if (change.type === 'write' || change.type === 'mkdir' || change.type === 'remove' || change.type === 'rename') this.listeners.emit(change);
  }

  private async readEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal, on: (event: string, data: string, id: string | null) => void): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let event = 'message';
    let data: string[] = [];
    let id: string | null = null;
    const abort = () => void reader.cancel().catch(() => {});
    signal.addEventListener('abort', abort, { once: true });
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.search(/\r?\n/)) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + (buffer[newline] === '\r' ? 2 : 1));
          if (line === '') {
            if (data.length || event !== 'message') on(event, data.join('\n'), id);
            event = 'message';
            data = [];
            id = null;
          } else if (line.startsWith(':')) continue;
          else {
            const colon = line.indexOf(':');
            const field = colon < 0 ? line : line.slice(0, colon);
            const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
            if (field === 'event') event = value;
            else if (field === 'data') data.push(value);
            else if (field === 'id') id = value;
          }
        }
      }
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  // --- history (contract §1; the History panel) -------------------------------------------

  /** A file's kept versions, newest first, the current one included; `before` is a page's `next`.
   * A server that keeps none answers 405 `not-supported`. */
  async versions(path: string, options: { before?: string; limit?: number } = {}): Promise<VersionsPage> {
    normalizePath(path);
    const params: Record<string, string> = { path };
    if (options.before) params.before = options.before;
    if (options.limit !== undefined) params.limit = String(options.limit);
    const response = await this.request('GET', 'versions', params, { headers: { accept: 'application/json' } });
    if (!response.ok) throw await this.failure(response, path);
    return (await response.json()) as VersionsPage;
  }

  /** One version's bytes. It isn't the file as it is now, so nothing of it is kept as known. */
  async readVersion(path: string, version: string): Promise<Blob> {
    normalizePath(path);
    const response = await this.request('GET', 'version', { path, version });
    if (!response.ok) throw await this.failure(response, path);
    return response.blob();
  }

  /** Makes an earlier version the file again, as a write: over the version the caller holds
   * (`ifMatch`, a VersionInfo's `version` or an ETag), or into a file that is gone (`ifAbsent`).
   * A stale one is a FileChangedError, as for a save. The version it replaces stays in history.
   *
   * The server's feed skips the echo of this tab's own change, so what a write does here is done
   * here: the version this store knows moves on, and its watchers hear the write, which is how an
   * open view reads the restored file and its next save meets the right version. */
  async restore(path: string, version: string, condition: RestoreCondition): Promise<FileEntry> {
    normalizePath(path);
    return this.serial(async () => {
      const headers: Record<string, string> = {};
      if ('ifAbsent' in condition) headers['if-none-match'] = '*';
      else headers['if-match'] = condition.ifMatch.startsWith('"') ? condition.ifMatch : `"${condition.ifMatch}"`;
      const response = await this.request('POST', 'restore', { path, version }, { headers: { ...headers, accept: 'application/json' } });
      if (response.status === 412) {
        const problem = await this.problem(response);
        throw new FileChangedError(path, problem.absent === true);
      }
      if (!response.ok) throw await this.failure(response, path);
      const { entry, etag } = (await response.json()) as { entry: FileEntry; etag: string };
      this.known.set(path, { etag });
      this.listeners.emit({ type: 'write', path });
      return entry;
    });
  }

  /** The files deleted from this project that can still be restored, newest first (`GET …/deleted`).
   * A server that doesn't list them answers 405 `not-supported`. */
  async deletedFiles(options: { limit?: number } = {}): Promise<DeletedFilesPage> {
    const params: Record<string, string> = {};
    if (options.limit !== undefined) params.limit = String(options.limit);
    return (await this.json('GET', 'deleted', params)) as DeletedFilesPage;
  }

  /** Who changed `path` and when, newest first, from the server's log (`GET <api>/changes`). The
   * route is the API's, not the project's, so it's asked of the API's root. */
  async changes(path: string, options: { limit?: number } = {}): Promise<ChangeRecord[]> {
    normalizePath(path);
    const params = new URLSearchParams({ project: this.projectId, path });
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const root = this.base.slice(0, this.base.lastIndexOf('/projects/'));
    let response: Response;
    try {
      response = await this.doFetch(`${root}/changes?${params.toString()}`, { cache: 'no-store', headers: { accept: 'application/json', 'nebula-client': this.client } });
    } catch (error) {
      throw new ServerUnreachableError(this.label, error);
    }
    if (!response.ok) throw await this.failure(response, path);
    return ((await response.json()) as { changes: ChangeRecord[] }).changes;
  }
}
