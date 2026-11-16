import { useCallback, useEffect, useState } from 'react';

/**
 * How a note is edited on this device: live preview (the Markdown drawn as
 * the page, around the line being edited) or its plain source. A per-device
 * preference, as the page width is, kept in localStorage under its own key.
 * Loaded with NoteView (it holds no CodeMirror), so the switch shows its state
 * before the editor's chunk arrives.
 */
export type EditMode = 'live' | 'source';

export const EDIT_MODE_KEY = 'nebula:note-editing';

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    // Storage switched off or blocked: live preview, for this visit.
    return undefined;
  }
}

export function readEditMode(): EditMode {
  try {
    return storage()?.getItem(EDIT_MODE_KEY) === 'source' ? 'source' : 'live';
  } catch {
    return 'live';
  }
}

function writeEditMode(mode: EditMode): void {
  try {
    storage()?.setItem(EDIT_MODE_KEY, mode);
  } catch {
    // A full or blocked storage keeps the choice for this visit only.
  }
}

/** The mode, and a way to change it that remembers; another tab's change is followed. */
export function useEditMode(): [EditMode, (mode: EditMode) => void] {
  const [mode, setMode] = useState<EditMode>(readEditMode);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === EDIT_MODE_KEY) setMode(readEditMode());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const change = useCallback((next: EditMode) => {
    writeEditMode(next);
    setMode(next);
  }, []);
  return [mode, change];
}
