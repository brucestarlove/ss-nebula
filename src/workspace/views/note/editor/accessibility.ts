import { Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap, ViewPlugin } from '@codemirror/view';

/**
 * What the note editor tells assistive technology and keyboard users beyond
 * what CodeMirror does itself (a textbox, multi-line, its completion list's
 * roles and `aria-activedescendant`, the live region): the editor's name
 * and description, a visible mark of keyboard focus, and Escape as the way
 * out. The drawn parts say their own (headings, links and task state:
 * livePreview.ts; tables: tables.ts; embeds: embeds.tsx).
 */

/** The editor's accessible name and, if given, what describes it (an element's id). */
export function editorNames(label: string, readOnly: boolean, describedBy?: string): Extension {
  return EditorView.contentAttributes.of({
    'aria-label': label,
    ...(readOnly ? { 'aria-readonly': 'true' } : {}),
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
  });
}

/**
 * Marks the editor `ws-cm-kbd` while it has focus that didn't come from a
 * pointer, so editor.css can draw a focus ring for a keyboard (Tab, Escape
 * and back, a shortcut) without framing the page for every click. The
 * caret alone is the mark for the pointer, as in any text field. The class
 * is an editor attribute, so CodeMirror keeps it when it redraws its own.
 */
/** When the last pointer press anywhere on the page happened: focus given by
 * code just after one (Edit clicked, which focuses the editor) is a pointer's. */
let lastPointer = -Infinity;
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => (lastPointer = performance.now()), { capture: true, passive: true });
}
const POINTER_FOCUS_MS = 1_000;

const focusMode = ViewPlugin.fromClass(
  class {
    pointer = false;
    keyboard = false;
  },
  {
    eventHandlers: {
      mousedown(_event, view) {
        this.pointer = true;
        // A click in the editor ends a keyboard user's ring: the caret is the mark now.
        if (this.keyboard) {
          this.keyboard = false;
          view.dispatch({});
        }
      },
      touchstart() {
        this.pointer = true;
      },
      focus(_event, view) {
        this.keyboard = !this.pointer && performance.now() - lastPointer > POINTER_FOCUS_MS;
        this.pointer = false;
        view.dispatch({});
      },
      blur(_event, view) {
        this.keyboard = false;
        this.pointer = false;
        view.dispatch({});
      },
    },
  },
);

export const keyboardFocus: Extension = [focusMode, EditorView.editorAttributes.of((view) => (view.plugin(focusMode)?.keyboard ? { class: 'ws-cm-kbd' } : null))];

/**
 * Escape leaves the editor for the page's toolbar (`leave` moves the focus),
 * so a keyboard user is never in a text box with no way out but Shift-Tab.
 * Lowest priority: an open completion list, the search panel and a
 * multiple selection each take Escape first, and only a bare Escape comes here.
 */
export function escapeLeaves(leave: () => boolean): Extension {
  return Prec.low(keymap.of([{ key: 'Escape', run: leave }]));
}
