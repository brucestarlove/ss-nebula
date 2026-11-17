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
 */
import { blobToText } from './bytes';
import { EntryTypeError, FileChangedError, FileExistsError, FileNotFoundError, FolderTooBigError } from './errors';
import { ChangeListeners } from './listeners';
import { addServerPlace } from './places';
import { comparePaths, isInside, normalizePath } from './paths';
import type { FileChange, FileEntry, FileStore, ProjectMeta, WriteOptions } from './types';

export const SERVER_API = '/nebula-api/v1';

/** Where a server says it is (Orbit's places note, point 4). */
export type ServerPlace = { tier: 'server'; label: string; url: string };

/** A project as the server lists it: its meta, and its folder's name there. */
export type ServerProject = ProjectMeta & { folder: string };

export type ServerInfo = { place: ServerPlace; projects: ServerProject[] };

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

type Problem = { error?: string; message?: string; exists?: boolean; absent?: boolean; expected?: 'file' | 'folder' };

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
export async function fetchServerInfo(options: { base?: string; fetch?: FetchLike } = {}): Promise<ServerInfo | null> {
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(`${options.base ?? ''}${SERVER_API}/place`, { headers: { accept: 'application/json' }, cache: 'no-store' });
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
  fetch?: FetchLike;
  /** The change cursor to resume from; open() reads it, so nothing made after it is missed. */
  cursor?: string;
  /** How long the feed may be down before watchers hear `unreachable`. */
  graceMs?: number;
};

type Known = { etag: string; text?: string };

export class HttpFileStore implements FileStore {
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

  constructor(options: HttpFileStoreOptions) {
    this.projectId = options.projectId;
    this.label = options.label;
    this.base = `${options.base ?? ''}${SERVER_API}/projects/${encodeURIComponent(options.projectId)}`;
    this.doFetch = options.fetch ?? fetch.bind(globalThis);
    this.cursor = options.cursor;
    this.graceMs = options.graceMs ?? 3_000;
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
    switch (problem.error) {
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
      const response = await this.request('POST', 'rename', { from, to });
      if (!response.ok) throw await this.failure(response, response.status === 404 ? from : to);
      this.forget(from, to);
      this.listeners.emit({ type: 'rename', from, to });
    });
  }

  async remove(path: string): Promise<void> {
    normalizePath(path);
    return this.serial(async () => {
      const response = await this.request('DELETE', 'file', { path });
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
    if (!this.feed) this.startFeed();
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      stop();
      if (this.listeners.size === 0) this.stopFeed();
    };
  }

  // --- the change feed -------------------------------------------------------

  private startFeed(): void {
    const controller = new AbortController();
    this.feed = controller;
    void this.runFeed(controller.signal);
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
    let first = true;
    while (!signal.aborted) {
      try {
        const params: Record<string, string> = this.cursor ? { since: this.cursor } : {};
        const response = await this.doFetch(this.url('events', params), { headers: { accept: 'text/event-stream', 'nebula-client': this.client }, cache: 'no-store', signal });
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
}
