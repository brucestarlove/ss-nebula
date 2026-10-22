import { holdsText } from '../../files/bytes';
import { FileChangedError } from '../../files/errors';
import type { FileChange, FileEntry, FileStore, WriteOptions } from '../../files/types';

/** A FileStore in memory, for development, the harness page and tests. It
 * follows the contract in src/files/types.ts; lane A ships the real one. */
export class MemoryStore implements FileStore {
  private files = new Map<string, { data: Blob; modified: number }>();
  private dirs = new Set<string>();
  private listeners = new Set<(change: FileChange) => void>();
  /** Milliseconds every call waits, to see saving states. */
  latency = 0;

  constructor(seed: Record<string, string | Blob> = {}) {
    for (const [path, data] of Object.entries(seed)) this.put(path, data);
  }

  private async tick() {
    if (this.latency > 0) await new Promise((resolve) => setTimeout(resolve, this.latency));
  }

  private put(path: string, data: string | Blob) {
    this.ensureParents(path);
    const blob = typeof data === 'string' ? new Blob([data], { type: 'text/plain' }) : data;
    this.files.set(path, { data: blob, modified: Date.now() });
  }

  private ensureParents(path: string) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) this.dirs.add(parts.slice(0, i).join('/'));
  }

  private emit(change: FileChange) {
    for (const listener of [...this.listeners]) queueMicrotask(() => listener(change));
  }

  private exists(path: string) {
    return this.files.has(path) || this.dirs.has(path);
  }

  private missing(path: string): Error {
    return new DOMException(`Nothing at ${path}`, 'NotFoundError');
  }

  async list(): Promise<FileEntry[]> {
    await this.tick();
    const entries: FileEntry[] = [];
    const hidden = (path: string) => path === '.nebula' || path.startsWith('.nebula/');
    for (const path of this.dirs) if (!hidden(path)) entries.push(this.entry(path)!);
    for (const path of this.files.keys()) if (!hidden(path)) entries.push(this.entry(path)!);
    return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  private entry(path: string): FileEntry | null {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const file = this.files.get(path);
    if (file) return { path, name, type: 'file', size: file.data.size, modified: file.modified };
    if (this.dirs.has(path)) return { path, name, type: 'dir' };
    return null;
  }

  async stat(path: string): Promise<FileEntry | null> {
    await this.tick();
    return this.entry(path);
  }

  async readText(path: string): Promise<string> {
    const blob = await this.readBlob(path);
    if (typeof blob.text === 'function') return blob.text();
    // jsdom's Blob has no text(); FileReader reads it there.
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
  }

  async readBlob(path: string): Promise<Blob> {
    await this.tick();
    const file = this.files.get(path);
    if (!file) throw this.missing(path);
    return file.data;
  }

  async write(path: string, data: string | Blob, options: WriteOptions = {}): Promise<void> {
    await this.tick();
    const expected = options.ifUnchanged;
    if (expected === 'absent' && this.exists(path)) throw new FileChangedError(path);
    if (expected !== undefined && expected !== 'absent') {
      const stored = this.files.get(path);
      if (!stored) throw new FileChangedError(path, true);
      // Compared, then written with nothing awaited in between: the file is
      // still the one compared.
      if (!(await holdsText(stored.data, expected.text)) || this.files.get(path) !== stored) throw new FileChangedError(path);
    }
    if (options.exclusive && this.exists(path)) throw new DOMException(`Something already exists at ${path}`, 'FileExistsError');
    if (this.dirs.has(path)) throw new DOMException(`${path} is a folder`, 'TypeMismatchError');
    this.put(path, data);
    this.emit({ type: 'write', path });
  }

  async mkdir(path: string): Promise<void> {
    await this.tick();
    if (this.files.has(path)) throw new DOMException(`${path} is a file`, 'TypeMismatchError');
    this.ensureParents(path);
    this.dirs.add(path);
    this.emit({ type: 'mkdir', path });
  }

  async rename(from: string, to: string): Promise<void> {
    await this.tick();
    if (!this.exists(from)) throw this.missing(from);
    if (this.exists(to)) throw new DOMException(`Something already exists at ${to}`, 'InvalidModificationError');
    if (to.startsWith(`${from}/`)) throw new DOMException('A folder can’t move into itself', 'InvalidModificationError');
    const move = (path: string) => to + path.slice(from.length);
    for (const [path, file] of [...this.files]) {
      if (path === from || path.startsWith(`${from}/`)) {
        this.files.delete(path);
        this.ensureParents(move(path));
        this.files.set(move(path), file);
      }
    }
    for (const path of [...this.dirs]) {
      if (path === from || path.startsWith(`${from}/`)) {
        this.dirs.delete(path);
        this.ensureParents(move(path));
        this.dirs.add(move(path));
      }
    }
    this.emit({ type: 'rename', from, to });
  }

  async remove(path: string): Promise<void> {
    await this.tick();
    if (!this.exists(path)) throw this.missing(path);
    for (const key of [...this.files.keys()]) if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
    for (const key of [...this.dirs]) if (key === path || key.startsWith(`${path}/`)) this.dirs.delete(key);
    this.emit({ type: 'remove', path });
  }

  watch(listener: (change: FileChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
