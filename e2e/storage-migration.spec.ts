// The migration in real browsers (review findings 5, 6 and 19): Web Locks
// across two tabs, a tab closed part-way, and the record in OPFS.
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, openHarness, test } from './harness/files-fixtures';
import './harness/storage-types';

const HARNESS = '/e2e/harness/storage-harness.html';

// The harness pages are served by the Vite dev server only.
test.skip(process.env.NEBULA_E2E_BUILT === '1', 'needs the dev server for e2e/harness/');

const hexagon = JSON.parse(readFileSync('sketches/workspace/assets/winter-hexagon.excalidraw', 'utf8'));

function legacy(boardId: string, canvasId: string, name: string): [string, string] {
  const key = `nebula:excalidraw:${encodeURIComponent(boardId)}:${encodeURIComponent(canvasId)}`;
  const document = {
    type: 'starscape.nebula.excalidraw',
    version: 1,
    boardId,
    canvasId,
    name,
    updatedAt: '2026-05-29T12:00:00.000Z',
    scene: hexagon,
    nebula: { ticketLinks: [], missionFrames: [], artifactRefs: [], semanticIndex: {} },
  };
  return [key, JSON.stringify(document)];
}

const SEED = Object.fromEntries([
  legacy('ss-nebula', 'main', 'Winter hexagon'),
  legacy('ss-nebula', 'ideas', 'Ideas'),
  legacy('ss-nebula', 'later', 'Later'),
  legacy('board/a', 'canvas b', 'Plan'),
]);

async function freshStart(page: Page): Promise<void> {
  await page.evaluate(() => window.storageHarness.wipe());
  await page.evaluate((seed) => window.storageHarness.seedLocalStorage(seed), SEED);
  expect(await page.evaluate(() => window.storageHarness.open())).toEqual({ persistent: true });
}

function projectFolders(tree: string[]): string[] {
  return tree.filter((path) => /^projects\/[^/]+\/$/.test(path));
}

test.describe('the migration across tabs', () => {
  test('two tabs at once: one moves everything, the other waits for the lock and finds it done', async ({ persistentContext }) => {
    const first = await openHarness(persistentContext, HARNESS);
    const second = await openHarness(persistentContext, HARNESS);
    await freshStart(first);
    expect(await second.evaluate(() => window.storageHarness.open())).toEqual({ persistent: true });

    // The first tab's writes are slow, so the second starts while it's still moving.
    const running = first.evaluate(() => window.storageHarness.migrate({ slowMs: 150 }));
    await expect.poll(() => first.evaluate(() => window.storageHarness.writes())).toBeGreaterThan(0);
    const [one, other] = await Promise.all([running, second.evaluate(() => window.storageHarness.migrate())]);

    expect([one.status, other.status]).toEqual(['migrated', 'already-done']);
    expect(projectFolders(await second.evaluate(() => window.storageHarness.tree()))).toHaveLength(2);
    expect((await second.evaluate(() => window.storageHarness.projects())).map((project) => project.name)).toEqual(['My First Project', 'board/a']);
    await first.close();
    await second.close();
  });

  test('a tab closed part-way: the next visit takes back the partial project, then moves everything once', async ({ persistentContext }) => {
    const closing = await openHarness(persistentContext, HARNESS);
    await freshStart(closing);
    // The second canvas never finishes: the tab closes under it, holding the lock.
    void closing.evaluate(() => window.storageHarness.migrate({ hangFrom: 2 })).catch(() => {});
    await expect.poll(() => closing.evaluate(() => window.storageHarness.writes())).toBe(2);
    expect(JSON.parse(await closing.evaluate(() => window.storageHarness.readTree('migration.json')))).toMatchObject({ status: 'in-progress', projects: ['ss-nebula'] });
    await closing.close();

    const next = await openHarness(persistentContext, HARNESS);
    expect(await next.evaluate(() => window.storageHarness.open())).toEqual({ persistent: true });
    const report = await next.evaluate(() => window.storageHarness.migrate());

    expect(report.status).toBe('migrated');
    expect((await next.evaluate(() => window.storageHarness.projects())).map((project) => project.name)).toEqual(['My First Project', 'board/a']);
    expect(projectFolders(await next.evaluate(() => window.storageHarness.tree()))).toHaveLength(2);
    expect(await next.evaluate(() => window.storageHarness.paths('ss-nebula'))).toEqual(['Ideas.excalidraw.md', 'Later.excalidraw.md', 'Winter hexagon.excalidraw.md']);
    const record = JSON.parse(await next.evaluate(() => window.storageHarness.readTree('migration.json')));
    expect(record).toMatchObject({ version: 1, status: 'done' });
    expect(record.canvases.map((canvas: { key: string }) => canvas.key).sort()).toEqual(Object.keys(SEED).sort());
    // The old keys are still there, unchanged.
    const storage = await next.evaluate(() => window.storageHarness.localStorage());
    for (const [key, value] of Object.entries(SEED)) expect(storage[key]).toBe(value);
    await next.close();
  });
});
