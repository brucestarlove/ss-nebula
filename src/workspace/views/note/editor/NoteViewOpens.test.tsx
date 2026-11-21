import { EditorView } from '@codemirror/view';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryFileStore } from '../../../../../e2e/harness/views-store';
import type { FileEntry } from '../../../../files/types';
import { byLabel, click, render, settle, waitFor, type Rendered } from '../../testing/render';
import NoteView from '../NoteView';
import { OPENS_EDITING_KEY } from './opensEditing';

// Read or edit, remembered (2.0.4): a note opens the way the last switch left it. State and focus, not words:
// which view is on the page, what storage holds, and where the keyboard is.

const entryFor = (path: string): FileEntry => ({ path, name: path.slice(path.lastIndexOf('/') + 1), type: 'file', size: 10, modified: Date.now() });
const FIRST = entryFor('Guides/First.md');
const SECOND = entryFor('Guides/Second.md');

const mounted: Rendered[] = [];
const extras: HTMLElement[] = [];
beforeEach(() => localStorage.clear());
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
  for (const element of extras.splice(0)) element.remove();
  document.body.innerHTML = '';
  localStorage.clear();
});

const store = () => createMemoryFileStore({ [FIRST.path]: '# First\n\nSome words.\n', [SECOND.path]: '# Second\n\nOther words.\n' });

async function open(entry: FileEntry, files = store(), props: { longNoteChars?: number } = {}) {
  const view = await render(<NoteView projectId="p" store={files} entry={entry} kind="note" {...props} />);
  mounted.push(view);
  await waitFor(() => expect(view.container.querySelector('.ws-prose, .cm-editor')).not.toBeNull());
  await settle(10);
  return view;
}

async function close(view: Rendered) {
  await view.unmount();
  mounted.splice(mounted.indexOf(view), 1);
}

const isEditing = (view: Rendered) => view.container.querySelector('.cm-editor') !== null;
const isReading = (view: Rendered) => view.container.querySelector('.ws-prose') !== null && !isEditing(view);
const editButton = (view: Rendered) => byLabel(view.container, 'Edit')!;
/** jsdom lays nothing out: a note counts as on screen when it has a box. */
function onScreen(view: Rendered) {
  for (const selector of ['.ws-note', '.ws-page']) {
    const element = view.container.querySelector<HTMLElement>(selector);
    if (element) element.getClientRects = () => [new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList;
  }
}
const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = window) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });

describe('a note opens as the last switch left it', () => {
  it('reads by default, and keeps reading until a switch is made', async () => {
    const view = await open(FIRST);
    expect(isReading(view)).toBe(true);
    expect(editButton(view).getAttribute('aria-pressed')).toBe('false');
    expect(localStorage.getItem(OPENS_EDITING_KEY)).toBeNull();
  });

  it('edits the next note after a switch to editing, and reads the next after a switch back', async () => {
    const files = store();
    const first = await open(FIRST, files);
    await click(editButton(first));
    await waitFor(() => expect(isEditing(first)).toBe(true));
    expect(localStorage.getItem(OPENS_EDITING_KEY)).toBe('edit');
    await close(first);

    const second = await open(SECOND, files);
    expect(isEditing(second)).toBe(true);
    expect(editButton(second).getAttribute('aria-pressed')).toBe('true');
    await click(editButton(second));
    await waitFor(() => expect(isReading(second)).toBe(true));
    expect(localStorage.getItem(OPENS_EDITING_KEY)).toBe('read');
    await close(second);

    const third = await open(FIRST, files);
    expect(isReading(third)).toBe(true);
  });

  it('writes the choice for Ctrl+E too (⌘E on a Mac)', async () => {
    const view = await open(FIRST);
    onScreen(view);
    await press('e', { ctrlKey: true });
    await waitFor(() => expect(isEditing(view)).toBe(true));
    expect(localStorage.getItem(OPENS_EDITING_KEY)).toBe('edit');
    await press('e', { ctrlKey: true });
    await waitFor(() => expect(isReading(view)).toBe(true));
    expect(localStorage.getItem(OPENS_EDITING_KEY)).toBe('read');
  });

  it('leaves Ctrl+E to the note on screen: a hidden tab’s note does nothing', async () => {
    const view = await open(FIRST);
    await press('e', { ctrlKey: true });
    await settle(30);
    expect(isReading(view)).toBe(true);
    expect(localStorage.getItem(OPENS_EDITING_KEY)).toBeNull();
  });

  it('opens to read when what is stored is not a choice', async () => {
    localStorage.setItem(OPENS_EDITING_KEY, 'whatever');
    expect(isReading(await open(FIRST))).toBe(true);
  });
});

describe('notes that can’t follow the choice', () => {
  const latin = () => createMemoryFileStore({ [FIRST.path]: new Blob([new Uint8Array([...new TextEncoder().encode('Caf'), 0xe9, 0x0a])]), [SECOND.path]: 'Plain.\n' });

  it('reads a note that isn’t UTF-8 whatever the choice, has no Edit button, and leaves the choice as it was', async () => {
    localStorage.setItem(OPENS_EDITING_KEY, 'edit');
    const files = latin();
    const view = await open(FIRST, files);
    expect(isEditing(view)).toBe(false);
    expect(view.container.querySelector('[aria-label="Edit"]')).toBeNull();
    onScreen(view);
    await press('e', { ctrlKey: true });
    expect(isEditing(view)).toBe(false);
    expect(localStorage.getItem(OPENS_EDITING_KEY)).toBe('edit');
    await close(view);
    // The next writable note still opens editing.
    expect(isEditing(await open(SECOND, files))).toBe(true);
  });

  const LONG = `# Log\n\n${'Seeing was steady.\n\n'.repeat(100)}`;
  const longStore = () => createMemoryFileStore({ [FIRST.path]: LONG });

  it('opens a long note as its source with the choice on reading, and the choice stays reading', async () => {
    const view = await open(FIRST, longStore(), { longNoteChars: 1_000 });
    await waitFor(() => expect(view.container.querySelector('[data-testid="code-editor"] .cm-editor')).not.toBeNull());
    expect(localStorage.getItem(OPENS_EDITING_KEY)).toBeNull();
  });

  it('opens a long note as its source with the choice on editing too', async () => {
    localStorage.setItem(OPENS_EDITING_KEY, 'edit');
    const view = await open(FIRST, longStore(), { longNoteChars: 1_000 });
    await waitFor(() => expect(view.container.querySelector('[data-testid="code-editor"] .cm-editor')).not.toBeNull());
    expect(view.container.querySelector('[data-testid="note-editor"]')).toBeNull();
  });

  it('“Read it” renders that one note and leaves the choice alone, while Edit writes it', async () => {
    localStorage.setItem(OPENS_EDITING_KEY, 'edit');
    const view = await open(FIRST, longStore(), { longNoteChars: 1_000 });
    await waitFor(() => expect(view.container.querySelector('.ws-long-note button')).not.toBeNull());
    await click(view.container.querySelector('.ws-long-note button'));
    await waitFor(() => expect(isReading(view)).toBe(true));
    expect(localStorage.getItem(OPENS_EDITING_KEY)).toBe('edit');
    await click(editButton(view));
    await waitFor(() => expect(isEditing(view)).toBe(true));
    expect(localStorage.getItem(OPENS_EDITING_KEY)).toBe('edit');
    await click(editButton(view));
    await waitFor(() => expect(isReading(view)).toBe(true));
    expect(localStorage.getItem(OPENS_EDITING_KEY)).toBe('read');
  });
});

describe('the keyboard', () => {
  function treeRow(): HTMLButtonElement {
    const row = document.createElement('button');
    row.textContent = 'Second.md';
    document.body.prepend(row);
    extras.push(row);
    return row;
  }

  it('stays where it is when a note opens already editing', async () => {
    localStorage.setItem(OPENS_EDITING_KEY, 'edit');
    const row = treeRow();
    row.focus();
    expect(document.activeElement).toBe(row);
    const view = await open(FIRST);
    await waitFor(() => expect(isEditing(view)).toBe(true));
    await settle(30);
    expect(document.activeElement).toBe(row);
  });

  it('goes into the editor on a switch to editing, and back to the Edit button on a switch to reading', async () => {
    const view = await open(FIRST);
    await click(editButton(view));
    await waitFor(() => expect(isEditing(view)).toBe(true));
    const cm = EditorView.findFromDOM(view.container.querySelector('.cm-editor') as HTMLElement)!;
    await waitFor(() => expect(cm.hasFocus).toBe(true));
    // Back to reading: the focus goes to the Edit button, not the top of the page.
    await click(editButton(view));
    await waitFor(() => expect(isReading(view)).toBe(true));
    expect(document.activeElement).toBe(editButton(view));
  });

  it('is taken into the editor by Ctrl+E as well', async () => {
    const view = await open(FIRST);
    onScreen(view);
    await press('e', { ctrlKey: true });
    await waitFor(() => expect(isEditing(view)).toBe(true));
    const cm = EditorView.findFromDOM(view.container.querySelector('.cm-editor') as HTMLElement)!;
    await waitFor(() => expect(cm.hasFocus).toBe(true));
  });
});

describe('another tab', () => {
  it('doesn’t move a note already open, and its change is read by the next note opened', async () => {
    const files = store();
    const view = await open(FIRST, files);
    const row = document.createElement('button');
    document.body.prepend(row);
    extras.push(row);
    row.focus();
    // The other tab switches to editing.
    localStorage.setItem(OPENS_EDITING_KEY, 'edit');
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: OPENS_EDITING_KEY, newValue: 'edit', storageArea: localStorage }));
    });
    await settle(30);
    expect(isReading(view)).toBe(true);
    expect(document.activeElement).toBe(row);
    expect(isEditing(await open(SECOND, files))).toBe(true);
  });
});

describe('Ctrl/⌘-A in a note', () => {
  /** Puts the selection inside `element`'s first text and sends Ctrl+A from `target`. */
  async function selectAll(view: Rendered, { inside, from }: { inside: 'page' | 'outside'; from?: HTMLElement }) {
    const page = view.container.querySelector('.ws-page') as HTMLElement;
    const outside = document.createElement('p');
    outside.textContent = 'A tab name';
    document.body.append(outside);
    extras.push(outside);
    const place = inside === 'page' ? (page.querySelector('.ws-prose p') as HTMLElement) : outside;
    const selection = window.getSelection()!;
    selection.collapse(place.firstChild!, 1);
    const event = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => {
      (from ?? document.body).dispatchEvent(event);
    });
    return { event, selection, page };
  }

  it('takes the page’s text when the selection is in the page, and nothing outside it', async () => {
    const view = await open(FIRST);
    onScreen(view);
    const { event, selection, page } = await selectAll(view, { inside: 'page' });
    expect(event.defaultPrevented).toBe(true);
    expect(selection.anchorNode).toBe(page);
    expect(selection.focusNode).toBe(page);
  });

  it('leaves it to the browser when the selection is outside the page', async () => {
    const view = await open(FIRST);
    onScreen(view);
    const { event, selection, page } = await selectAll(view, { inside: 'outside' });
    expect(event.defaultPrevented).toBe(false);
    expect(selection.anchorNode).not.toBe(page);
  });

  it('does nothing for a note that isn’t on screen (a hidden tab’s view)', async () => {
    const view = await open(FIRST);
    const { event, selection, page } = await selectAll(view, { inside: 'page' });
    expect(event.defaultPrevented).toBe(false);
    expect(selection.anchorNode).not.toBe(page);
  });

  it('leaves it alone in an input, a textarea and the editor', async () => {
    const view = await open(FIRST);
    onScreen(view);
    const page = view.container.querySelector('.ws-page') as HTMLElement;
    const input = document.createElement('input');
    const area = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    page.append(input, area, editable);
    for (const field of [input, area, editable]) {
      const { event, selection } = await selectAll(view, { inside: 'page', from: field });
      expect(event.defaultPrevented, field.tagName).toBe(false);
      expect(selection.anchorNode, field.tagName).not.toBe(page);
    }
  });
});
