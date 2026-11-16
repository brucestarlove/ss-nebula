import { createContext, useContext } from 'react';
import type { FileEntry } from '../../../files/types';

/**
 * What a note's links need of the project around it:
 * every file in the project, to say which a `[[link]]` names (see
 * views/note/links.ts), and a way to open one in a tab. The workspace
 * provides it around the stage; a view rendered alone gets no files and a
 * no-op, so it still draws.
 */
export type ProjectLinks = {
  /** Every file of the project (no folders), kept current as the files change. */
  files: readonly FileEntry[];
  /** Opens a file in a tab (or goes to its tab), and to a heading in it where the view can. */
  open(path: string, heading?: string): void;
  /** Makes the note a link to nothing names, in the folder of the note it's written in (`from`), and opens it. It says why when it can't. */
  create(target: string, from: string): void;
};

export const NO_LINKS: ProjectLinks = { files: [], open: () => {}, create: () => {} };

export const ProjectLinksContext = createContext<ProjectLinks>(NO_LINKS);

export function useProjectLinks(): ProjectLinks {
  return useContext(ProjectLinksContext);
}
