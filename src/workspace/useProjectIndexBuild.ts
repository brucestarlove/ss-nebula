/**
 * The project index, built and kept current. It lives in memory and is
 * rebuilt when a project opens.
 *
 * When a project opens, every note and canvas is read once, a few at a time,
 * yielding to the page between slices so typing never waits on it. After
 * that it follows the project: the file list the workspace already keeps
 * (a new file, a file gone, a file whose size or time changed) and the
 * store's own changes (a write, a rename, a folder coming back), re-reading
 * only the files named. Works the same on every tier: it only uses the
 * FileStore interface.
 *
 * The workspace holds one ProjectIndexSource and never re-renders for it:
 * ProjectIndexProvider subscribes, so only what reads the index (search, the
 * Linked from panel, the tags panel) draws again when it changes.
 */
import { useEffect, useState } from 'react';
import { kindFromContent, kindFromName } from '../files/kinds';
import { basename, isInside } from '../files/paths';
import { isProjectSignal, type FileChange, type FileEntry, type FileStore } from '../files/types';
import { canvasRecord, LinkResolver, makeIndex, movedRecord, noteRecord, resolveRecord, type IndexRecord } from './indexBuild';
import type { CanvasWords } from './indexCanvas';
import { movePath } from './paths';
import { EMPTY_INDEX, type ProjectIndex } from './projectIndex';

/** Files read at once. */
const BATCH = 8;
/** How long the index works before it lets the page have a turn. */
const SLICE_MS = 8;
/** How often a growing index is shown while the project is first read, and after. */
const FIRST_PUBLISH_MS = 400;
const PUBLISH_MS = 120;
/**
 * How long a written file waits before the index reads it again. Autosave
 * writes a note every few keystrokes; reading it after each would be a read
 * per save (a request per save on a server), and would race the view that
 * wrote it for the store. The index reads once the writes have settled.
 */
const WRITE_SETTLE_MS = 600;
/** Files bigger than these are indexed by name only: a note of megabytes is
 * rarely prose, and a canvas that size is mostly pictures, whose JSON would
 * stall the page to yield a few words. */
const NOTE_BYTES_LIMIT = 8 * 1024 * 1024;
const CANVAS_BYTES_LIMIT = 24 * 1024 * 1024;

/** The kind the index reads a file as, by its name; null for a file it doesn't read. */
function indexable(name: string): 'note' | 'canvas' | null {
  const kind = kindFromName(name);
  return kind === 'note' || kind === 'canvas' ? kind : null;
}

function signature(entry: FileEntry): string {
  return `${entry.size ?? ''}:${entry.modified ?? ''}`;
}

function samePaths(a: readonly FileEntry[], b: readonly FileEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index].path !== b[index].path) return false;
  return true;
}

function yieldToPage(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

type Read = { path: string; version: number; text: string | null };

export class ProjectIndexSource {
  private snapshot: ProjectIndex = EMPTY_INDEX;
  private readonly listeners = new Set<() => void>();
  private store: FileStore | null = null;
  private unwatch: (() => void) | null = null;
  /** Bumped when the project changes: reads from before are dropped. */
  private generation = 0;
  private records = new Map<string, IndexRecord>();
  /** The signature each file was last read at; null after a rename, until the file list shows it at its new path. */
  private sigs = new Map<string, string | null>();
  /** Bumped whenever something happens to a path, so a read begun before it is dropped. */
  private versions = new Map<string, number>();
  private files = new Map<string, FileEntry>();
  private allFiles: readonly FileEntry[] = [];
  private resolver = new LinkResolver([]);
  private resolverGeneration = 0;
  private readonly queue = new Set<string>();
  private readonly reading = new Set<string>();
  private runner: number | null = null;
  private ready = false;
  private filesSeen = false;
  private changed = false;
  private timer: number | undefined;
  /** Files written since the last settle, read again once writing stops (WRITE_SETTLE_MS). */
  private readonly written = new Set<string>();
  private writeTimer: number | undefined;
  private canvasReader: Promise<((text: string, path: string) => CanvasWords) | null> | null = null;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly current = () => this.snapshot;

  /** Starts on a project's store (or none): everything known before is let go. */
  open(store: FileStore | null) {
    this.close();
    this.store = store;
    this.records = new Map();
    this.sigs = new Map();
    this.versions = new Map();
    this.files = new Map();
    this.allFiles = [];
    this.resolver = new LinkResolver([]);
    this.resolverGeneration += 1;
    this.queue.clear();
    this.reading.clear();
    this.ready = false;
    this.filesSeen = false;
    this.changed = false;
    if (this.snapshot !== EMPTY_INDEX) {
      this.snapshot = EMPTY_INDEX;
      this.emit();
    }
    if (store) this.unwatch = store.watch((change) => this.onChange(change));
  }

  close() {
    this.generation += 1;
    this.unwatch?.();
    this.unwatch = null;
    window.clearTimeout(this.timer);
    this.timer = undefined;
    window.clearTimeout(this.writeTimer);
    this.writeTimer = undefined;
    this.written.clear();
  }

  /** The project's files, as the workspace lists them (kept current as they change). */
  setFiles(files: readonly FileEntry[]) {
    if (!this.store) return;
    const next = new Map<string, FileEntry>();
    for (const entry of files) {
      if (entry.type === 'file' && indexable(entry.name) && !isInside(entry.path, '.nebula')) next.set(entry.path, entry);
    }
    // A file added, removed or renamed: every link is resolved again.
    if (!samePaths(files, this.allFiles)) {
      this.resolver = new LinkResolver(files);
      this.resolverGeneration += 1;
      this.changed = true;
    }
    this.allFiles = files;
    this.files = next;

    for (const path of [...this.records.keys()]) {
      if (next.has(path)) continue;
      this.records.delete(path);
      this.sigs.delete(path);
      this.changed = true;
    }
    // Notes first, then canvases, which take longer to read.
    const queued: string[] = [];
    for (const [path, entry] of next) {
      const sig = signature(entry);
      const known = this.sigs.get(path);
      if (known === null && this.records.has(path)) {
        this.sigs.set(path, sig);
        continue;
      }
      if (known === sig) continue;
      this.sigs.set(path, sig);
      // A file already read that changed is a write: it waits for writing to settle, as onChange's do.
      if (this.records.has(path)) this.settle(path);
      else queued.push(path);
    }
    queued.sort((a, b) => Number(indexable(basename(a)) === 'canvas') - Number(indexable(basename(b)) === 'canvas'));
    for (const path of queued) this.enqueue(path);
    this.filesSeen = true;
    this.run();
    if (this.changed) this.publishSoon();
  }

  /* ---- following the store --------------------------------------- */

  private onChange(change: FileChange) {
    if (isProjectSignal(change)) {
      // The folder back, or the project moved: anything may have changed meanwhile.
      if (change.type === 'reachable' || change.type === 'moved') {
        for (const path of this.files.keys()) this.enqueue(path);
        this.run();
      }
      return;
    }
    if (change.type === 'mkdir') return;
    if (change.type === 'write') {
      if (!this.files.has(change.path)) return; // a new file: the file list brings it
      this.settle(change.path);
      return;
    }
    if (change.type === 'remove') {
      const all = change.path === '';
      for (const path of [...this.records.keys(), ...this.queue, ...this.reading]) {
        if (!all && !isInside(path, change.path)) continue;
        this.touch(path);
        this.queue.delete(path);
        this.sigs.delete(path);
        if (this.records.delete(path)) this.changed = true;
      }
      this.publishSoon();
      return;
    }
    // A rename: what was read moves with it, and its links resolve from the new place.
    const { from, to } = change;
    for (const path of [...this.records.keys()]) {
      if (!isInside(path, from)) continue;
      const record = this.records.get(path)!;
      const moved = movePath(path, from, to);
      this.touch(path);
      this.records.delete(path);
      this.sigs.delete(path);
      this.records.set(moved, movedRecord(record, moved));
      this.sigs.set(moved, null);
      this.changed = true;
    }
    // A write still settling follows its file.
    for (const path of [...this.written]) {
      if (!isInside(path, from)) continue;
      this.written.delete(path);
      this.written.add(movePath(path, from, to));
    }
    for (const path of [...this.queue, ...this.reading]) {
      if (!isInside(path, from)) continue;
      this.touch(path);
      this.queue.delete(path);
      this.sigs.delete(movePath(path, from, to));
    }
    this.publishSoon();
  }

  /** Reads a written file again once writing has stopped for WRITE_SETTLE_MS. */
  private settle(path: string) {
    this.written.add(path);
    window.clearTimeout(this.writeTimer);
    const generation = this.generation;
    this.writeTimer = window.setTimeout(() => {
      if (generation !== this.generation) return;
      for (const written of this.written) if (this.files.has(written)) this.enqueue(written);
      this.written.clear();
      this.run();
    }, WRITE_SETTLE_MS);
  }

  /* ---- reading ----------------------------------------------------- */

  private touch(path: string) {
    this.versions.set(path, (this.versions.get(path) ?? 0) + 1);
  }

  private enqueue(path: string) {
    this.touch(path);
    this.queue.add(path);
  }

  private run() {
    if (!this.store || this.runner === this.generation) return;
    void this.drain(this.generation, this.store);
  }

  private async drain(generation: number, store: FileStore) {
    this.runner = generation;
    try {
      let slice = performance.now();
      while (this.queue.size > 0 && this.generation === generation) {
        const batch = [...this.queue].slice(0, BATCH);
        for (const path of batch) {
          this.queue.delete(path);
          this.reading.add(path);
        }
        const reads = await Promise.all(batch.map((path) => this.read(store, path)));
        for (const path of batch) this.reading.delete(path);
        for (const read of reads) {
          if (this.generation !== generation) return;
          await this.apply(read);
          if (performance.now() - slice > SLICE_MS) {
            this.publishSoon();
            await yieldToPage();
            slice = performance.now();
          }
        }
      }
    } catch (reason) {
      console.error('Nebula: the project index stopped', reason);
    } finally {
      if (this.runner === generation) this.runner = null;
    }
    if (this.generation !== generation) return;
    if (this.queue.size > 0) {
      this.run();
      return;
    }
    if (this.filesSeen && !this.ready) {
      this.ready = true;
      this.publishNow();
    } else if (this.changed) this.publishSoon();
  }

  private async read(store: FileStore, path: string): Promise<Read> {
    const version = this.versions.get(path) ?? 0;
    const entry = this.files.get(path);
    if (!entry) return { path, version, text: null };
    const limit = indexable(entry.name) === 'canvas' ? CANVAS_BYTES_LIMIT : NOTE_BYTES_LIMIT;
    if ((entry.size ?? 0) > limit) return { path, version, text: '' };
    try {
      return { path, version, text: await store.readText(path) };
    } catch {
      return { path, version, text: null };
    }
  }

  private async apply({ path, version, text }: Read) {
    // Something happened to the file since the read began: a newer read, a rename or a removal has it.
    if ((this.versions.get(path) ?? 0) !== version) return;
    const entry = this.files.get(path);
    if (!entry || text === null) {
      // Gone, or unreadable: read again when the file list next changes.
      this.sigs.delete(path);
      if (this.records.delete(path)) this.changed = true;
      return;
    }
    let record: IndexRecord;
    if (kindFromContent(entry.name, text) === 'note') record = noteRecord(path, text);
    else {
      const read = text ? await this.canvasWords() : null;
      if ((this.versions.get(path) ?? 0) !== version) return;
      const words = read ? read(text, path) : { lines: [], links: [] };
      record = canvasRecord(path, words.lines, words.links);
    }
    this.records.set(path, record);
    this.changed = true;
  }

  /** indexCanvas.ts, loaded the first time a canvas is read; null if it can't be. */
  private canvasWords() {
    this.canvasReader ??= import('./indexCanvas').then(
      (module) => module.canvasWords,
      (reason: unknown) => {
        console.error('Nebula: could not load the canvas reader for search', reason);
        this.canvasReader = null;
        return null;
      },
    );
    return this.canvasReader;
  }

  /* ---- publishing ------------------------------------------------- */

  private publishSoon() {
    if (this.timer !== undefined || !this.changed) return;
    this.timer = window.setTimeout(
      () => {
        this.timer = undefined;
        this.publishNow();
      },
      this.ready ? PUBLISH_MS : FIRST_PUBLISH_MS,
    );
  }

  private publishNow() {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.store) return;
    this.changed = false;
    const records: IndexRecord[] = [];
    for (const [path, record] of this.records) {
      const resolved = resolveRecord(record, this.resolver, this.resolverGeneration);
      if (resolved !== record) this.records.set(path, resolved);
      records.push(resolved);
    }
    this.snapshot = makeIndex(records, this.ready);
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}

/**
 * The open project's index source: one for the workspace's life, started on
 * each project's store and fed the project's files. Reading it doesn't
 * re-render the caller; ProjectIndexProvider does that for what reads it.
 */
export function useProjectIndexBuild(store: FileStore | null, files: readonly FileEntry[]): ProjectIndexSource {
  const [source] = useState(() => new ProjectIndexSource());
  useEffect(() => {
    source.open(store);
    return () => source.close();
  }, [source, store]);
  useEffect(() => {
    source.setFiles(files);
  }, [source, store, files]);
  return source;
}
