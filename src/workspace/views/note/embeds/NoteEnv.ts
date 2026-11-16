import { createContext } from 'react';
import type { FileStore } from '../../../../files/types';

/**
 * Where the text being drawn comes from: the note's own file, so its links
 * and embeds resolve from its folder, and how deep inside embeds it is, so an
 * embed can stop (a note that embeds itself, or two that embed each other).
 * The reading view provides it for the note; an embedded note gets its own.
 */
export type NoteEnv = {
  store: FileStore;
  projectId: string;
  /** The path of the note this text belongs to. */
  path: string;
  /** 0 for the note on the page, 1 inside its embeds, and so on. */
  depth: number;
  /** The notes drawn around this one, outermost first, this one last. */
  chain: readonly string[];
};

export const NoteEnvContext = createContext<NoteEnv | null>(null);
