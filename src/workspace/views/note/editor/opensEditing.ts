/**
 * Whether a note opens to read or to edit on this device: the person's last
 * choice between the two, remembered from one note to the next (Bruce,
 * 2026-11-21: "remember user preference of read/edit when they switch between
 * notes"). A per-device preference, as the edit mode (editMode.ts) and the
 * page width are, kept in localStorage under its own key.
 *
 * It is read each time a note opens, never held by a view, so every note view
 * in the tab and in other tabs agrees on what the next note does. It is
 * deliberately not followed live: a note already open stays as it is when
 * another tab switches, instead of changing under the reader (and taking the
 * keyboard into an editor).
 *
 * Nothing here knows about notes that can't follow it. A read-only note
 * always opens to read, and a long note always opens as its source, whatever
 * this says, and neither changes it (NoteView.tsx).
 */
export const OPENS_EDITING_KEY = 'nebula:note-opens';

/** A choice storage wouldn't keep (blocked or full): it lasts for this visit instead. */
let unsaved: boolean | undefined;

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** Whether the next note opens to edit (true) or to read (false, the default). */
export function readOpensEditing(): boolean {
  if (unsaved !== undefined) return unsaved;
  try {
    return storage()?.getItem(OPENS_EDITING_KEY) === 'edit';
  } catch {
    return false;
  }
}

/** Remembers that the next note opens to edit (true) or to read (false). */
export function writeOpensEditing(editing: boolean): void {
  try {
    const where = storage();
    if (where) {
      where.setItem(OPENS_EDITING_KEY, editing ? 'edit' : 'read');
      unsaved = undefined;
      return;
    }
  } catch {
    // A full or blocked storage keeps the choice for this visit only.
  }
  unsaved = editing;
}
