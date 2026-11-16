import { undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryFileStore } from '../../../../../e2e/harness/views-store';
import type { FileEntry } from '../../../../files/types';
import { byLabel, click, render, settle, waitFor, type Rendered } from '../../testing/render';
import NoteView from '../NoteView';

// NoteView's editing block: Edit opens the live editor; a note too long for
// live preview keeps the plain source editor (CodeEditor) and its bar.

const PATH = 'Guides/Observing plan.md';
const entry: FileEntry = { path: PATH, name: 'Observing plan.md', type: 'file', size: 100, modified: Date.now() };

describe('NoteView’s editor', () => {
  const mounted: Rendered[] = [];
  afterEach(async () => {
    for (const view of mounted.splice(0)) await view.unmount();
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('Edit opens the live editor', async () => {
    const store = createMemoryFileStore({ [PATH]: '## Targets\n\n- [ ] The Pleiades\n' });
    const view = await render(<NoteView projectId="p" store={store} entry={entry} kind="note" />);
    mounted.push(view);
    await waitFor(() => expect(view.container.querySelector('.ws-prose')).not.toBeNull());
    await click(byLabel(view.container, 'Edit'));
    await waitFor(() => expect(view.container.querySelector('[data-testid="note-editor"] .cm-editor')).not.toBeNull());
    expect(view.container.querySelector('[data-testid="code-editor"]')).toBeNull();
    expect(view.container.querySelector('.cm-content')?.getAttribute('aria-label')).toBe('Observing plan, markdown source');
  });

  it('a note over the limit opens as its plain source, with its bar', async () => {
    const store = createMemoryFileStore({ [PATH]: `# Log\n\n${'Seeing was steady.\n\n'.repeat(100)}` });
    const view = await render(<NoteView projectId="p" store={store} entry={entry} kind="note" longNoteChars={1_000} />);
    mounted.push(view);
    await waitFor(() => expect(view.container.querySelector('[data-testid="code-editor"] .cm-editor')).not.toBeNull());
    expect(view.container.querySelector('.ws-long-note')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="note-editor"]')).toBeNull();
  });

  it('a long note read and then edited again still opens as its plain source', async () => {
    const store = createMemoryFileStore({ [PATH]: `# Log\n\n${'Seeing was steady.\n\n'.repeat(100)}` });
    const view = await render(<NoteView projectId="p" store={store} entry={entry} kind="note" longNoteChars={1_000} />);
    mounted.push(view);
    await waitFor(() => expect(view.container.querySelector('.ws-long-note button')).not.toBeNull());
    await click(view.container.querySelector('.ws-long-note button'));
    await waitFor(() => expect(view.container.querySelector('.ws-prose')).not.toBeNull());
    await click(byLabel(view.container, 'Edit'));
    await waitFor(() => expect(view.container.querySelector('[data-testid="code-editor"] .cm-editor')).not.toBeNull());
    expect(view.container.querySelector('.ws-cm-live')).toBeNull();
  });

  it('a note that grows past the limit while edited keeps its editor (and its undo)', async () => {
    const store = createMemoryFileStore({ [PATH]: 'Short.\n' });
    const view = await render(<NoteView projectId="p" store={store} entry={entry} kind="note" longNoteChars={1_000} />);
    mounted.push(view);
    await waitFor(() => expect(view.container.querySelector('.ws-prose')).not.toBeNull());
    await click(byLabel(view.container, 'Edit'));
    await waitFor(() => expect(view.container.querySelector('[data-testid="note-editor"] .cm-editor')).not.toBeNull());
    const editor = view.container.querySelector('.cm-editor');
    const cm = EditorView.findFromDOM(editor as HTMLElement)!;
    await act(async () => {
      cm.dispatch({ changes: { from: 0, insert: 'x'.repeat(2_000) } });
    });
    await settle(20);
    expect(view.container.querySelector('.cm-editor')).toBe(editor);
    // Still live preview, so its switch still switches.
    expect(byLabel(view.container, 'Markdown source')?.getAttribute('aria-disabled')).toBeNull();
  });

  describe('the source switch', () => {
    const TEXT = '## Targets\n\nSee **Orion** tonight.\n';

    async function editing(text = TEXT, longNoteChars?: number) {
      const store = createMemoryFileStore({ [PATH]: text });
      const view = await render(<NoteView projectId="p" store={store} entry={entry} kind="note" longNoteChars={longNoteChars} />);
      mounted.push(view);
      if (longNoteChars === undefined) {
        await waitFor(() => expect(view.container.querySelector('.ws-prose')).not.toBeNull());
        expect(byLabel(view.container, 'Markdown source'), 'no switch while reading').toBeNull();
        await click(byLabel(view.container, 'Edit'));
      }
      await waitFor(() => expect(view.container.querySelector('.cm-editor')).not.toBeNull());
      return view;
    }

    const cmOf = (view: Rendered) => EditorView.findFromDOM(view.container.querySelector('.cm-editor') as HTMLElement)!;
    const switchOf = (view: Rendered) => byLabel(view.container, 'Markdown source')!;

    it('turns live preview off and on in the same editor: undo, the cursor and the editor itself stay', async () => {
      const view = await editing();
      const cm = cmOf(view);
      expect(view.container.querySelector('.cm-line.ws-cm-h2')).not.toBeNull();
      expect(switchOf(view).getAttribute('aria-pressed')).toBe('false');
      await act(async () => {
        cm.dispatch({ changes: { from: TEXT.length - 1, insert: ' Clear.' }, selection: { anchor: 5 } });
      });

      await click(switchOf(view));
      expect(switchOf(view).getAttribute('aria-pressed')).toBe('true');
      expect(cmOf(view)).toBe(cm);
      const host = view.container.querySelector('[data-testid="note-editor"]')!;
      expect(host.classList.contains('ws-cm-live')).toBe(false);
      expect(host.classList.contains('ws-cm-source')).toBe(true);
      // Every decoration is off: the Markdown as written.
      expect(view.container.querySelector('.cm-line.ws-cm-h2')).toBeNull();
      expect(view.container.querySelector('.cm-content')?.textContent).toContain('## TargetsSee **Orion** tonight. Clear.');
      expect(cm.state.selection.main.head).toBe(5);
      expect(undo(cm)).toBe(true);
      expect(cm.state.doc.toString()).toBe(TEXT);

      await click(switchOf(view));
      expect(view.container.querySelector('.cm-line.ws-cm-h2')).not.toBeNull();
      expect(host.classList.contains('ws-cm-live')).toBe(true);
    });

    it('is kept on this device: the next note edited opens as it was left', async () => {
      const first = await editing();
      await click(switchOf(first));
      expect(localStorage.getItem('nebula:note-editing')).toBe('source');
      await first.unmount();
      mounted.splice(mounted.indexOf(first), 1);
      const second = await editing();
      expect(switchOf(second).getAttribute('aria-pressed')).toBe('true');
      expect(second.container.querySelector('.cm-line.ws-cm-h2')).toBeNull();
    });

    it('switches with Ctrl+Shift+E (⌘⇧E on a Mac), which Help lists', async () => {
      const view = await editing();
      expect(switchOf(view).getAttribute('title')).toMatch(/\(Ctrl\+Shift\+E\)$/);
      // jsdom lays nothing out; the shortcut works only for the note on screen.
      const note = view.container.querySelector('.ws-note') as HTMLElement;
      note.getClientRects = () => [new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList;
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'E', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
      });
      expect(switchOf(view).getAttribute('aria-pressed')).toBe('true');
      expect(view.container.querySelector('.cm-line.ws-cm-h2')).toBeNull();
    });

    it('a long note: the switch shows the source is kept, and says why it can’t change', async () => {
      const view = await editing(`# Log\n\n${'Seeing was steady.\n\n'.repeat(100)}`, 1_000);
      const control = switchOf(view);
      expect(control.getAttribute('aria-pressed')).toBe('true');
      expect(control.getAttribute('aria-disabled')).toBe('true');
      expect(control.getAttribute('title')).toBe('This note is long, so it’s edited as its source, which stays quick.');
      await click(control);
      expect(localStorage.getItem('nebula:note-editing')).toBeNull();
      expect(control.getAttribute('aria-pressed')).toBe('true');
    });
  });
});
