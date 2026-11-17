// A rename in another tab while one canvas write is in flight and a newer one is queued behind it.
// No other change is made anywhere: the newest drawing must end up in the file.
import { expect, it } from 'vitest';
import hexagonText from '../../../../e2e/assets/images/winter-hexagon.excalidraw?raw';
import { MemoryFileStore } from '../../../../src/files/memoryStore';
import { readObsidianExcalidrawMarkdown, toObsidianExcalidrawMarkdown } from '../../../../src/nebula/excalidraw/obsidianMarkdown';
import type { ExcalidrawScene } from '../../../../src/nebula/excalidraw/scene';
import { createEmptyNebulaMetadata } from '../../../../src/nebula/excalidraw/metadata';
import { createFileSceneStore } from '../../../../src/workspace/views/canvas/fileSceneStore';
import { hasUnsavedChanges } from '../../../../src/workspace/views/shared/fileSessions';
/** Kept from the reviewer's probes; prints nothing. */
const log = (...args: unknown[]): void => void args;
const hexagon = JSON.parse(hexagonText) as ExcalidrawScene;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const doc = (s: ExcalidrawScene) => ({ type: 'starscape.nebula.excalidraw' as const, version: 1 as const, boardId: 'p', canvasId: 'x', name: 'x', updatedAt: '', scene: s, nebula: createEmptyNebulaMetadata() });
const bump = (s: ExcalidrawScene, x: number, dv: number): ExcalidrawScene => ({ ...s, elements: s.elements.map((e, i) => (i === 0 ? { ...e, x, version: Number(e.version ?? 1) + dv } : e)) });
const X = (t: string) => readObsidianExcalidrawMarkdown(t).elements[0].x;

for (const format of ['md', 'json'] as const) it(`newest drawing survives a rename elsewhere with two writes queued (${format})`, async () => {
  const A = format === 'md' ? 'A.excalidraw.md' : 'A.excalidraw';
  const B = format === 'md' ? 'B.excalidraw.md' : 'B.excalidraw';
  const read = (t: string) => (format === 'md' ? X(t) : JSON.parse(t).elements[0].x);
  const disk = new MemoryFileStore();
  await disk.write(A, format === 'md' ? toObsidianExcalidrawMarkdown(hexagon, { compressed: true }) : hexagonText);
  const tab = disk.twin({ delay: (c) => (c.type === 'write' && c.path === A ? wait(40) : undefined) });
  const s = createFileSceneStore({ store: tab, path: A, intervalMs: 1, scope: 'reaim-' + format });
  const loaded = (await s.load({ boardId: 'p', canvasId: 'c' }))!;
  await s.save(doc(loaded.scene));
  await s.save(doc(bump(loaded.scene, 777, 1))); // W1: in flight, held in the store
  await wait(8);
  await s.save(doc(bump(loaded.scene, 888, 2))); // W2: queued behind W1
  await wait(8);
  await disk.twin().rename(A, B); // another tab: waits for W1, carries it
  await s.flush();
  await wait(50);
  await s.flush();
  const x = read(await disk.readText(B));
  log('reaim', format, { x, state: s.getState(), unsaved: hasUnsavedChanges(), files: (await disk.list()).map((e) => e.path) });
  await s.dispose();
  // Round 5 (G1): at 41a30fd the older drawing (777) was written over the newest, with no conflict
  // and nothing unsaved. The re-aimed write puts its scene back only when nothing newer is queued.
  expect(x).toBe(888);
  expect(hasUnsavedChanges()).toBe(false);
});
