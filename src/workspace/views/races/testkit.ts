import type { FileChange, FileStore } from '../../../files/types';
import { createEmptyNebulaMetadata } from '../../../nebula/excalidraw/metadata';
import type { ExcalidrawScene } from '../../../nebula/excalidraw/scene';

/** Shared by the round 7 race tests (the sixth review's N1-N7). Every wait
 * here waits for a state; the bound only ends a wait for one that never
 * comes, so a red test fails rather than hangs. */

/** Polls until `check` holds, or `ms` pass: whether it came. */
export async function until(check: () => boolean | Promise<boolean>, ms = 1000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  return true;
}

/** A promise the test opens. */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

/** A tab whose messages from other tabs can be held back and let through
 * later, in order, as a slow tab hears them. */
export function lateMessages(inner: FileStore) {
  let holding = false;
  const held: Array<() => void> = [];
  const store: FileStore = Object.assign(Object.create(inner) as FileStore, {
    watch: (listener: (change: FileChange) => void) =>
      inner.watch((change) => {
        if (holding) held.push(() => listener(change));
        else listener(change);
      }),
  });
  return {
    store,
    hold: () => void (holding = true),
    release: () => {
      holding = false;
      for (const deliver of held.splice(0)) deliver();
    },
    /** Lets the oldest held message through; the rest stay held. */
    releaseOne: () => held.shift()?.(),
  };
}

export type Element = { id: string; type: string; x: number; y: number; width: number; height: number; angle: number; strokeColor: string; version: number; versionNonce: number; isDeleted: boolean };

export const el = (id: string, x: number, version: number, nonce: number, stroke = '#000000'): Element => ({
  id,
  type: 'rectangle',
  x,
  y: 20,
  width: 100,
  height: 50,
  angle: 0,
  strokeColor: stroke,
  version,
  versionNonce: nonce,
  isDeleted: false,
});

export const scene = (elements: Element[]): ExcalidrawScene => ({ type: 'excalidraw', version: 2, source: 't', elements, appState: { viewBackgroundColor: '#ffffff' }, files: {} });

/** One rectangle at `x`. */
export const drawing = (x: number, version = 1) => scene([el('a', x, version, version)]);

export const doc = (drawn: ExcalidrawScene) => ({
  type: 'starscape.nebula.excalidraw' as const,
  version: 1 as const,
  boardId: 'p',
  canvasId: 'c',
  name: 'c',
  updatedAt: '',
  scene: drawn,
  nebula: createEmptyNebulaMetadata(),
});

export const parse = (text: string) => JSON.parse(text) as ExcalidrawScene;

export const REF = { boardId: 'p', canvasId: 'c' };
