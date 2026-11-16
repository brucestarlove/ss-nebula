import { createContext } from 'react';
import type { Preferences } from '../../../files/types';

/**
 * The page width switch on a note (Bruce, 2026-10-25: "the Notes fixed/stretch
 * as a switcher on the note card"). It is the same per-device preference as
 * Settings → Page width; the workspace provides it. Where nothing provides it
 * (a view on its own), the note shows no switch.
 */
export type PageWidth = {
  width: Preferences['width'];
  setWidth(width: Preferences['width']): void;
};

export const PageWidthContext = createContext<PageWidth | null>(null);
