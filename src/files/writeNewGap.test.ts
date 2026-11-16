import { describe, expect, it } from 'vitest';
import { OpfsFileStore } from './opfsStore';

/**
 * S10: a new file is written under a temporary name and
 * moved into place. An app that makes the same name in that gap must not
 * be overwritten: the name is checked again, under the same lock, right
 * before move().
 */
const notFound = () => new DOMException('Not found', 'NotFoundError');

class FakeFile {
  readonly kind = 'file' as const;
  name: string;
  text = '';
  parent: FakeDir;
  constructor(name: string, parent: FakeDir) {
    this.name = name;
    this.parent = parent;
  }
  async getFile(): Promise<File> {
    return new File([this.text], this.name);
  }
  async createWritable() {
    let next = '';
    return {
      write: async (data: string | Blob) => {
        next += typeof data === 'string' ? data : await data.text();
        this.parent.onWrite?.();
      },
      close: async () => {
        this.text = next;
      },
      abort: async () => {},
    };
  }
  /** As Chrome may: replaces whatever has the name. */
  async move(parent: FakeDir, name: string): Promise<void> {
    this.parent.children.delete(this.name);
    this.name = name;
    parent.children.set(name, this);
  }
}

class FakeDir {
  readonly kind = 'directory' as const;
  readonly name = 'Notes';
  readonly children = new Map<string, FakeFile>();
  onWrite?: () => void;
  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<FakeFile> {
    const found = this.children.get(name);
    if (found) return found;
    if (!options.create) throw notFound();
    const made = new FakeFile(name, this);
    this.children.set(name, made);
    return made;
  }
  async getDirectoryHandle(): Promise<never> {
    throw notFound();
  }
  async removeEntry(name: string): Promise<void> {
    if (!this.children.delete(name)) throw notFound();
  }
}

describe('S10: a new file never replaces one another app made meanwhile', () => {
  it('refuses when the name was taken during the write, and the other app’s file stays', async () => {
    const root = new FakeDir();
    const store = new OpfsFileStore(root as unknown as FileSystemDirectoryHandle, { fileLocks: { request: (_name, _options, callback) => callback() } });
    root.onWrite = () => {
      root.onWrite = undefined;
      const theirs = new FakeFile('Plan.md', root);
      theirs.text = 'made by another app';
      root.children.set('Plan.md', theirs);
    };
    await expect(store.write('Plan.md', 'mine', { exclusive: true })).rejects.toMatchObject({ name: 'FileExistsError' });
    expect(root.children.get('Plan.md')?.text).toBe('made by another app');
    expect([...root.children.keys()]).toEqual(['Plan.md']);
  });
});
