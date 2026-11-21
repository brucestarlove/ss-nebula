import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPENS_EDITING_KEY } from './opensEditing';

// Whether the next note opens to read or to edit: the last choice, kept per device. It is read each time a
// note opens; the key of live preview / source (`nebula:note-editing`) is a different choice and stays as it is.

type Module = typeof import('./opensEditing');

/** A fresh copy of the module: its note of a choice storage wouldn't keep is module state. */
async function fresh(): Promise<Module> {
  vi.resetModules();
  return import('./opensEditing');
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('read or edit, remembered', () => {
  it('opens to read when nothing was chosen', async () => {
    const { readOpensEditing } = await fresh();
    expect(readOpensEditing()).toBe(false);
  });

  it('opens to edit after a switch to edit, and to read after a switch back, each time it is read', async () => {
    const { readOpensEditing, writeOpensEditing } = await fresh();
    writeOpensEditing(true);
    expect(localStorage.getItem(OPENS_EDITING_KEY)).toBe('edit');
    expect(readOpensEditing()).toBe(true);
    writeOpensEditing(false);
    expect(localStorage.getItem(OPENS_EDITING_KEY)).toBe('read');
    expect(readOpensEditing()).toBe(false);
  });

  it('follows what another tab wrote, since it reads storage each time rather than holding the choice', async () => {
    const { readOpensEditing } = await fresh();
    expect(readOpensEditing()).toBe(false);
    localStorage.setItem(OPENS_EDITING_KEY, 'edit');
    expect(readOpensEditing()).toBe(true);
  });

  it('reads a value that is neither as reading', async () => {
    const { readOpensEditing } = await fresh();
    for (const garbage of ['', 'banana', 'EDIT', 'true', '1', '{"edit":true}']) {
      localStorage.setItem(OPENS_EDITING_KEY, garbage);
      expect(readOpensEditing(), garbage).toBe(false);
    }
  });

  it('opens to read when storage can’t be read', async () => {
    const { readOpensEditing } = await fresh();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError');
    });
    expect(readOpensEditing()).toBe(false);
  });

  it('keeps the choice for the visit when storage won’t take it', async () => {
    const { readOpensEditing, writeOpensEditing } = await fresh();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Full', 'QuotaExceededError');
    });
    writeOpensEditing(true);
    expect(localStorage.getItem(OPENS_EDITING_KEY)).toBeNull();
    expect(readOpensEditing()).toBe(true);
    writeOpensEditing(false);
    expect(readOpensEditing()).toBe(false);
  });

  it('goes back to storage once it takes a write again', async () => {
    const { readOpensEditing, writeOpensEditing } = await fresh();
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Full', 'QuotaExceededError');
    });
    writeOpensEditing(true);
    expect(readOpensEditing()).toBe(true);
    set.mockRestore();
    writeOpensEditing(false);
    expect(readOpensEditing()).toBe(false);
    localStorage.setItem(OPENS_EDITING_KEY, 'edit');
    expect(readOpensEditing()).toBe(true);
  });

  it('never touches the live-preview or source choice', async () => {
    const { writeOpensEditing } = await fresh();
    localStorage.setItem('nebula:note-editing', 'source');
    writeOpensEditing(true);
    writeOpensEditing(false);
    expect(localStorage.getItem('nebula:note-editing')).toBe('source');
    localStorage.removeItem('nebula:note-editing');
    writeOpensEditing(true);
    expect(localStorage.getItem('nebula:note-editing')).toBeNull();
  });
});
