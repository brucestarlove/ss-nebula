import { createContext } from 'react';

export const NoteContext = createContext<{ toggle(offsetInBody: number): void } | null>(null);

/** Whether this note's web images may load, and a way for a held-back one
 * to say it's there (it returns its goodbye). */
export type WebImages = { load: boolean; hold(): () => void };
export const WebImagesContext = createContext<WebImages>({ load: false, hold: () => () => undefined });

/** Notes whose web images were asked for, while this page is open. */
export const webImagesAllowed = new Set<string>();

