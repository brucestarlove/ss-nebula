import { createContext } from 'react';
import type { FileKind } from '../../../files/types';

/** What the workspace lets a view ask of it about its own file. */
export type ViewActions = {
  /** Shows the file in another kind's view: a canvas that won't open, as a note. */
  openAs?(kind: FileKind): void;
};

export const ViewActionsContext = createContext<ViewActions>({});
