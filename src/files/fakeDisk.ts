/**
 * A test double for a folder on a disk: FileSystemDirectoryHandle and
 * FileSystemFileHandle as OpfsFileStore uses them, in memory, with the two
 * differences between disks the folder tier has to live with:
 *
 * - `caseInsensitive` (macOS, Windows): `a.md` and `A.md` are one entry,
 *   named as it was made, and `isSameEntry` says so;
 * - `directoryMove: false`: an engine whose `move()` can't move a folder
 *   (it throws NotSupportedError), so the copy-then-remove fallback runs.
 *
 * `calls` records every `removeEntry` (name, recursive) and every `move`,
 * and `before(op, name)` lets a test fail or interleave an operation.
 * Synthetic only: nothing here reads a real disk.
 */

import { blobToText } from './bytes';

const problem = (name: string) => new DOMException(name, name);

export type DiskOptions = {
  caseInsensitive?: boolean;
  /** Whether move() can move a folder; files always can. `false`: it throws
   * NotSupportedError. `'missing'`: a folder has no move() at all, as in
   * Chromium (probed on 156, e2e/folder-store.spec.ts). */
  directoryMove?: boolean | 'missing';
};

export type DiskCall = { op: 'removeEntry'; dir: string; name: string; recursive: boolean } | { op: 'move'; from: string; to: string };

type Shared = Required<DiskOptions> & {
  calls: DiskCall[];
  /** Runs before an operation; throwing fails it. */
  before?: (op: 'move' | 'removeEntry' | 'write', name: string) => void | Promise<void>;
};

export class DiskFile {
  readonly kind = 'file' as const;
  name: string;
  text: string | Blob = '';
  modified = 1;
  parent: DiskDir;
  constructor(name: string, parent: DiskDir) {
    this.name = name;
    this.parent = parent;
  }
  get path(): string {
    return this.parent.pathOf(this.name);
  }
  async getFile(): Promise<File> {
    return new File([this.text], this.name, { lastModified: this.modified });
  }
  async createWritable() {
    let next: Array<string | Blob> = [];
    return {
      write: async (data: string | Blob) => {
        await this.parent.shared.before?.('write', this.name);
        next.push(data);
      },
      close: async () => {
        this.text = new Blob(next);
        this.modified += 1;
      },
      abort: async () => {
        next = [];
      },
    };
  }
  async isSameEntry(other: unknown): Promise<boolean> {
    return other === this;
  }
  /** move(parent, name) as Chrome gives it: a file replaces what has the name. */
  async move(parent: DiskDir, name: string): Promise<void> {
    await this.parent.shared.before?.('move', name);
    this.parent.shared.calls.push({ op: 'move', from: this.path, to: parent.pathOf(name) });
    const existing = parent.find(name);
    if (existing && existing !== this) parent.drop(existing);
    this.parent.drop(this);
    this.name = name;
    this.parent = parent;
    parent.put(this);
  }
}

export class DiskDir {
  readonly kind = 'directory' as const;
  name: string;
  parent: DiskDir | null;
  readonly shared: Shared;
  private readonly children = new Map<string, DiskFile | DiskDir>();
  constructor(name: string, parent: DiskDir | null, shared: Shared) {
    this.name = name;
    this.parent = parent;
    this.shared = shared;
  }
  static root(name = 'Notes', options: DiskOptions = {}): DiskDir {
    return new DiskDir(name, null, { caseInsensitive: false, directoryMove: true, ...options, calls: [] });
  }

  get calls(): DiskCall[] {
    return this.shared.calls;
  }
  set before(hook: Shared['before']) {
    this.shared.before = hook;
  }

  private key(name: string): string {
    return this.shared.caseInsensitive ? name.toLowerCase() : name;
  }
  find(name: string): DiskFile | DiskDir | undefined {
    return this.children.get(this.key(name));
  }
  put(entry: DiskFile | DiskDir): void {
    this.children.set(this.key(entry.name), entry);
  }
  drop(entry: DiskFile | DiskDir): void {
    if (this.children.get(this.key(entry.name)) === entry) this.children.delete(this.key(entry.name));
  }
  /** The folder's own path from the disk's root ('' for the root). */
  get path(): string {
    return this.parent ? this.parent.pathOf(this.name) : '';
  }
  pathOf(name: string): string {
    return this.path ? `${this.path}/${name}` : name;
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<DiskFile> {
    const found = this.find(name);
    if (found) {
      if (found.kind !== 'file') throw problem('TypeMismatchError');
      return found;
    }
    if (!options.create) throw problem('NotFoundError');
    const made = new DiskFile(name, this);
    this.put(made);
    return made;
  }
  async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<DiskDir> {
    const found = this.find(name);
    if (found) {
      if (found.kind !== 'directory') throw problem('TypeMismatchError');
      return found;
    }
    if (!options.create) throw problem('NotFoundError');
    const made = new DiskDir(name, this, this.shared);
    this.put(made);
    return made;
  }
  async removeEntry(name: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.shared.before?.('removeEntry', name);
    this.shared.calls.push({ op: 'removeEntry', dir: this.path, name, recursive: options.recursive === true });
    const found = this.find(name);
    if (!found) throw problem('NotFoundError');
    if (found.kind === 'directory' && found.children.size > 0 && !options.recursive) throw problem('InvalidModificationError');
    this.drop(found);
  }
  async *values(): AsyncIterable<DiskFile | DiskDir> {
    for (const child of [...this.children.values()]) yield child;
  }
  async *keys(): AsyncIterable<string> {
    for (const child of this.children.values()) yield child.name;
  }
  async isSameEntry(other: unknown): Promise<boolean> {
    return other === this;
  }
  get move(): ((parent: DiskDir, name: string) => Promise<void>) | undefined {
    return this.shared.directoryMove === 'missing' ? undefined : (parent, name) => this.moveTo(parent, name);
  }
  private async moveTo(parent: DiskDir, name: string): Promise<void> {
    if (!this.shared.directoryMove) throw problem('NotSupportedError');
    await this.shared.before?.('move', name);
    this.shared.calls.push({ op: 'move', from: this.path, to: parent.pathOf(name) });
    const existing = parent.find(name);
    if (existing && existing !== this) throw problem('InvalidModificationError');
    this.parent?.drop(this);
    this.name = name;
    this.parent = parent;
    parent.put(this);
  }

  private async folderAt(parts: string[], create: boolean): Promise<DiskDir> {
    if (parts.length === 0) return this;
    return (await this.getDirectoryHandle(parts[0], { create })).folderAt(parts.slice(1), create);
  }

  /** Test helpers: add a file (and its folders) straight to the disk. */
  async seed(path: string, text: string | Blob): Promise<DiskFile> {
    const parts = path.split('/');
    const dir = await this.folderAt(parts.slice(0, -1), true);
    const file = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    file.text = text;
    return file;
  }
  /** Every path on the disk, as it is named there, sorted; folders end in '/'. */
  tree(prefix = ''): string[] {
    const out: string[] = [];
    for (const child of this.children.values()) {
      const path = prefix + child.name;
      if (child.kind === 'directory') out.push(`${path}/`, ...child.tree(`${path}/`));
      else out.push(path);
    }
    return out.sort();
  }
  async read(path: string): Promise<string> {
    const parts = path.split('/');
    const dir = await this.folderAt(parts.slice(0, -1), false);
    return blobToText(await (await dir.getFileHandle(parts[parts.length - 1])).getFile());
  }
}
