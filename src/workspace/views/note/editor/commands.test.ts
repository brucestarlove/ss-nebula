import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { noteEditorSetup } from './setup';

// The editing helpers, on a real editor (jsdom): keys go through the
// editor's own keymaps (runScopeHandlers), typing through its input handlers.
// `|` marks the cursor, `[` `]`… no: `<` and `>` mark a selection.

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

/** An editor holding `doc`, where `|` is the cursor and `«…»` a selection. */
function editor(marked: string): EditorView {
  const anchor = marked.includes('«') ? marked.indexOf('«') : marked.indexOf('|');
  const doc = marked.replace(/[|«»]/g, '');
  const head = marked.includes('»') ? marked.indexOf('»') - 1 : anchor;
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: noteEditorSetup({ label: 'Note', readOnly: false }) }),
  });
  views.push(view);
  return view;
}

/** The document with `|` at the cursor, or `«…»` around the selection. */
function shown(view: EditorView): string {
  const { from, to, empty } = view.state.selection.main;
  const doc = view.state.doc.toString();
  if (empty) return `${doc.slice(0, from)}|${doc.slice(from)}`;
  return `${doc.slice(0, from)}«${doc.slice(from, to)}»${doc.slice(to)}`;
}

function press(view: EditorView, key: string, modifiers: { ctrl?: boolean; shift?: boolean } = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, ctrlKey: modifiers.ctrl, shiftKey: modifiers.shift, bubbles: true, cancelable: true });
  return runScopeHandlers(view, event, 'editor');
}

/** Types `text` as the editor's input handlers see it (then inserts it, as the browser would). */
function type(view: EditorView, text: string) {
  for (const char of text) {
    const { from, to } = view.state.selection.main;
    const insert = () => view.state.update({ changes: { from, to, insert: char }, selection: { anchor: from + 1 }, userEvent: 'input.type' });
    const handled = view.state.facet(EditorView.inputHandler).some((handler) => handler(view, from, to, char, insert));
    if (!handled) view.dispatch(insert());
  }
}

describe('Enter in a list', () => {
  it('continues a list, a task list and a quote', () => {
    const list = editor('- Red flashlight|');
    expect(press(list, 'Enter')).toBe(true);
    expect(shown(list)).toBe('- Red flashlight\n- |');
    const tasks = editor('- [x] Orion|');
    press(tasks, 'Enter');
    expect(shown(tasks)).toBe('- [x] Orion\n- [ ] |');
    const quote = editor('> Give your eyes time|');
    press(quote, 'Enter');
    expect(shown(quote)).toBe('> Give your eyes time\n> |');
    const numbered = editor('1. One|');
    press(numbered, 'Enter');
    expect(shown(numbered)).toBe('1. One\n2. |');
  });

  it('ends the list on an empty item, even the second of a tight list', () => {
    const second = editor('- Thermos\n- |');
    press(second, 'Enter');
    expect(shown(second)).toBe('- Thermos\n|');
    const third = editor('- A\n- B\n- |');
    press(third, 'Enter');
    expect(shown(third)).toBe('- A\n- B\n|');
  });
});

describe('Tab and Shift-Tab in a list', () => {
  it('indent an item under the one above, with its own items, and outdent it again', () => {
    const view = editor('- Targets\n- Orion|\n  - M42\n- Pack');
    expect(press(view, 'Tab')).toBe(true);
    expect(shown(view)).toBe('- Targets\n  - Orion|\n    - M42\n- Pack');
    expect(press(view, 'Tab', { shift: true })).toBe(true);
    expect(shown(view)).toBe('- Targets\n- Orion|\n  - M42\n- Pack');
  });

  it('indent a numbered item by its parent’s marker, and every item a selection touches', () => {
    const numbered = editor('1. One\n2. Two|');
    press(numbered, 'Tab');
    expect(shown(numbered)).toBe('1. One\n   2. Two|');
    const both = editor('- A\n- «B\n- C»');
    press(both, 'Tab');
    expect(both.state.doc.toString()).toBe('- A\n  - B\n  - C');
  });

  it('leave a first item and a top-level outdent where they are, and Tab outside a list to the browser', () => {
    const first = editor('- Only|');
    expect(press(first, 'Tab')).toBe(true);
    expect(shown(first)).toBe('- Only|');
    expect(press(first, 'Tab', { shift: true })).toBe(true);
    expect(shown(first)).toBe('- Only|');
    // Outside a list Tab moves the focus on, as it does everywhere on the page.
    const prose = editor('Plain words.|');
    expect(press(prose, 'Tab')).toBe(false);
    expect(shown(prose)).toBe('Plain words.|');
  });
});

describe('wrapping a selection by typing', () => {
  it('wraps it in **, _, `, ~~, [ ] and ( ), keeping it selected', () => {
    const cases: Array<[string, string]> = [
      ['**', '**«clear»**'],
      ['_', '_«clear»_'],
      ['`', '`«clear»`'],
      ['~~', '~~«clear»~~'],
      ['[', '[«clear»]'],
      ['(', '(«clear»)'],
    ];
    for (const [typed, expected] of cases) {
      const view = editor('Skies «clear» tonight');
      type(view, typed);
      expect(shown(view), typed).toBe(`Skies ${expected} tonight`);
    }
  });

  it('types the character as ever with nothing selected', () => {
    const view = editor('2 |3');
    type(view, '*');
    expect(shown(view)).toBe('2 *|3');
  });
});

describe('Ctrl/⌘-B and Ctrl/⌘-I', () => {
  it('make a selection bold or italic, and take it back off', () => {
    const view = editor('Skies «clear» tonight');
    expect(press(view, 'b', { ctrl: true })).toBe(true);
    expect(shown(view)).toBe('Skies **«clear»** tonight');
    press(view, 'b', { ctrl: true });
    expect(shown(view)).toBe('Skies «clear» tonight');
    expect(press(view, 'i', { ctrl: true })).toBe(true);
    expect(shown(view)).toBe('Skies *«clear»* tonight');
    press(view, 'i', { ctrl: true });
    expect(shown(view)).toBe('Skies «clear» tonight');
  });

  it('with the cursor inside bold words, take the bold off them', () => {
    const view = editor('Skies **cle|ar** tonight');
    press(view, 'b', { ctrl: true });
    expect(shown(view)).toBe('Skies cle|ar tonight');
  });

  it('with nothing selected, leave the cursor between the marks', () => {
    const view = editor('Skies |');
    press(view, 'b', { ctrl: true });
    expect(shown(view)).toBe('Skies **|**');
  });
});

describe('keys the editor leaves alone, and keeps', () => {
  it('leaves Ctrl/⌘-K to the app’s search', () => {
    const view = editor('Skies|');
    expect(press(view, 'k', { ctrl: true })).toBe(false);
    expect(shown(view)).toBe('Skies|');
  });

  it('keeps Ctrl/⌘-F’s search panel, and Ctrl/⌘-Z and Y', () => {
    const view = editor('Skies|');
    expect(press(view, 'f', { ctrl: true })).toBe(true);
    expect(view.dom.querySelector('.cm-search')).not.toBeNull();
    view.focus();
    view.dispatch({ changes: { from: 5, insert: ' clear' }, userEvent: 'input.type' });
    press(view, 'z', { ctrl: true });
    expect(view.state.doc.toString()).toBe('Skies');
    press(view, 'y', { ctrl: true });
    expect(view.state.doc.toString()).toBe('Skies clear');
  });
});
