// Pre-existing: another tab's save that lands between a session's check and its write.
import { expect, it } from 'vitest';
import hexagonText from '../../../../e2e/assets/images/winter-hexagon.excalidraw?raw';
import { MemoryFileStore } from '../../../../src/files/memoryStore';
import type { FileChange, FileStore } from '../../../../src/files/types';
import { readObsidianExcalidrawMarkdown, toObsidianExcalidrawMarkdown } from '../../../../src/nebula/excalidraw/obsidianMarkdown';
import type { ExcalidrawScene } from '../../../../src/nebula/excalidraw/scene';
import { createEmptyNebulaMetadata } from '../../../../src/nebula/excalidraw/metadata';
import { createFileSceneStore } from '../../../../src/workspace/views/canvas/fileSceneStore';
import { createTextSession } from '../../../../src/workspace/views/shared/textSession';
/** Kept from the reviewer's probes; prints nothing. */
const log = (...args: unknown[]): void => void args;
const hexagon = JSON.parse(hexagonText) as ExcalidrawScene;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const doc = (s: ExcalidrawScene) => ({ type: 'starscape.nebula.excalidraw' as const, version: 1 as const, boardId: 'p', canvasId: 'x', name: 'x', updatedAt: '', scene: s, nebula: createEmptyNebulaMetadata() });
const bump = (s: ExcalidrawScene, x: number, dv: number): ExcalidrawScene => ({ ...s, elements: s.elements.map((e, i) => (i === 0 ? { ...e, x, version: Number(e.version ?? 1) + dv } : e)) });
const X = (t: string) => readObsidianExcalidrawMarkdown(t).elements[0].x;

/** The other tab's write lands right after this session's check reads the file (no rename at all). */
function landAfterCheck(inner: FileStore, path: string, theirs: () => Promise<void>, hookOn = 'stat') {
  let armed = false;
  const arm = () => { armed = true; };
  const store = new Proxy(inner, { get(target, prop, receiver) {
    const v = Reflect.get(target, prop, receiver);
    if (typeof v !== 'function') return v;
    type Call = (...args: unknown[]) => unknown;
    if (prop === 'watch') return (l: (c: FileChange) => void) => (v as Call).call(target, (c: FileChange) => { log('event', JSON.stringify(c)); l(c); });
    if (prop === 'readText' || prop === 'stat' || prop === 'write') return async (...args: unknown[]) => {
      log('call', String(prop), String(args[0]), prop === 'write' ? (String(args[0]).endsWith('.md') && String(args[1]).length > 100 ? 'x=' + X(String(args[1])) : String(args[1])) : '');
      const r = await (v as Call).apply(target, args);
      if (prop === 'readText') log(' ->', String(args[0]), String(r).length > 100 ? 'x=' + X(String(r)) : String(r));
      if (armed && args[0] === path && prop === hookOn) { armed = false; log('-- theirs lands now'); await theirs(); }
      return r;
    };
    return (...args: unknown[]) => (v as Call).apply(target, args);
  } }) as FileStore;
  return { store, arm };
}

it('canvas, no rename: a save landing between the check and the write is overwritten silently', async () => {
  const disk = new MemoryFileStore();
  const path = 'c.excalidraw.md';
  await disk.write(path, toObsidianExcalidrawMarkdown(hexagon, { compressed: true }));
  const other = disk.twin();
  const theirs = toObsidianExcalidrawMarkdown(bump(hexagon, 4242, 5), { compressed: true });
  const g = landAfterCheck(disk.twin(), path, () => other.write(path, theirs));
  const s = createFileSceneStore({ store: g.store, path, intervalMs: 1000, scope: 'toctou-c' });
  const loaded = (await s.load({ boardId: 'p', canvasId: 'c' }))!;
  await s.save(doc(loaded.scene));
  await s.save(doc(bump(loaded.scene, 888, 2)));
  g.arm();
  await s.flush();
  await wait(30);
  const x = X(await disk.readText(path));
  log('TOCTOU canvas no rename', { x, state: s.getState() });
  await s.dispose();
  // Round 5 (G3): at 41a30fd theirs (4242) was overwritten with no conflict. The write expects the
  // text the check saw, under the write's own lock, so theirs stays and the canvas asks.
  expect(x).toBe(4242);
  expect(s.getState().conflict).toBe(true);
  const copies = (await disk.list()).filter((e) => e.path.includes('(conflict '));
  expect(copies).toHaveLength(1);
  expect(X(await disk.readText(copies[0].path))).toBe(888);
});

it('note, no rename: same window', async () => {
  const disk = new MemoryFileStore();
  await disk.write('n.md', 'v1');
  const other = disk.twin();
  const g = landAfterCheck(disk.twin(), 'n.md', () => other.write('n.md', 'theirs'));
  const s = createTextSession(g.store, 'n.md', { saveDelayMs: 1000, scope: 'toctou-n' });
  await s.ready;
  s.edit('mine');
  // the note's check is stat-first; force a read by making the stat differ
  await disk.twin().write('n.md', 'v1');
  await wait(5);
  g.arm();
  await s.flush();
  await wait(30);
  const onDisk = await disk.readText('n.md');
  log('TOCTOU note no rename', { onDisk, state: s.getState() });
  await s.dispose();
  // Round 5 (G3): whichever call the hook catches, neither is lost: theirs stays at the file
  // (or mine was written before theirs landed) and mine is on disk or in a copy.
  const texts = await Promise.all((await disk.list()).map((e) => disk.readText(e.path)));
  expect(texts).toContain('mine');
  expect(onDisk === 'theirs' || texts.includes('theirs')).toBe(true);
});

it('note, no rename, theirs lands right after the stat check', async () => {
  const disk = new MemoryFileStore();
  await disk.write('m.md', 'v1');
  const other = disk.twin();
  const g = landAfterCheck(disk.twin(), 'm.md', () => other.write('m.md', 'theirs'), 'stat');
  const s = createTextSession(g.store, 'm.md', { saveDelayMs: 1000, scope: 'toctou-m' });
  await s.ready;
  s.edit('mine');
  g.arm();
  await s.flush();
  await wait(30);
  const onDisk = await disk.readText('m.md');
  log('TOCTOU note stat-hook', { onDisk, state: s.getState() });
  await s.dispose();
  const all = await Promise.all((await disk.list()).map(async (e) => [e.path, await disk.readText(e.path)]));
  log('TOCTOU note files', all);
  // Round 5 (G3): at 41a30fd theirs was gone with no conflict. Now theirs stays and mine is kept.
  expect(onDisk).toBe('theirs');
  expect(all.some(([p, t]) => p.includes('(conflict ') && t === 'mine')).toBe(true);
});
