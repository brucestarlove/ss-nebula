import { Facet, type EditorState } from '@codemirror/state';
import type { FileStore } from '../../../../files/types';
import { NO_LINKS, type ProjectLinks } from '../../shared/projectLinks';

/**
 * What the note editor knows of the project around it: the project's files
 * and a way to open one (useProjectLinks(), read by NoteEditor), plus the
 * note's own path, which resolveLink() needs to say which file a link names,
 * and the store its embeds and headings are read from (NoteView's props).
 *
 * NoteEditor puts it in a compartment and reconfigures that when the files
 * change, so link state follows the project without the editor being
 * rebuilt (its undo history, selection and scroll stay). Read it with
 * projectLinksOf(state) from any extension: wikilink completion and embeds
 * (part 2 of the editor lane) build on it.
 */
export type EditorLinks = ProjectLinks & {
  /** The note's own path in the project ('' when the editor stands alone). */
  path: string;
  /** Where the project's files are read from, for embeds and a link's headings (null when the editor stands alone). */
  store: FileStore | null;
  projectId: string;
};

const NONE: EditorLinks = { ...NO_LINKS, path: '', store: null, projectId: '' };

export const projectLinksFacet = Facet.define<EditorLinks, EditorLinks>({
  combine: (values) => values[0] ?? NONE,
});

export function projectLinksOf(state: EditorState): EditorLinks {
  return state.facet(projectLinksFacet);
}
