import {
  closeIntro,
  currentProjectId,
  decodeCanvasFile,
  expect,
  legacyFixtures,
  liveScene,
  localStorageSnapshot,
  openApp,
  openFromTree,
  row,
  seedLocalStorage,
  storedProjects,
  storedText,
  switcherTitle,
  test,
} from './app-fixtures';

// Someone arriving from Nebula 1.x:
// every board becomes a project and every canvas a file in it, the old keys
// stay exactly as they were, the note about it shows once, and old links
// still open the canvas they named.

test('canvases saved by Nebula 1.x move into projects, open with the same elements, and the old keys stay', async ({ page, context }) => {
  const { storage, canvases } = legacyFixtures();
  await seedLocalStorage(context, storage);
  const errors = await openApp(page);

  const intro = page.locator('dialog.ws-welcome');
  await expect(intro).toContainText('Your canvases are now files in projects.');
  await expect(intro).toContainText('The originals stay where they were.');
  await closeIntro(page, 'Got it');

  // One project per board: the default board is "My First Project", the other
  // keeps its id as its name; each canvas is a file.
  const projects = await storedProjects(page);
  expect(projects.map((project) => project.name).sort()).toEqual(['My First Project', 'board/a']);
  const mine = projects.find((project) => project.name === 'My First Project')!;
  const other = projects.find((project) => project.name === 'board/a')!;
  expect(mine.id).toBe('ss-nebula');
  expect(mine.files.filter((path) => !path.startsWith('.nebula/'))).toEqual(['The Pleiades.excalidraw.md', 'Winter hexagon.excalidraw.md']);
  expect(other.files.filter((path) => !path.startsWith('.nebula/'))).toEqual(['Plan- phase 1-2.excalidraw.md']);
  // Orbit metadata that isn't empty went to .nebula/legacy-metadata.json.
  expect(await storedText(page, mine.id, '.nebula/legacy-metadata.json')).toContain('ORB-12');

  // Each canvas opens in Excalidraw with the elements (and the image) it had.
  for (const canvas of canvases) {
    const project = canvas.boardId === 'ss-nebula' ? mine : other;
    if (currentProjectId(page) !== project.id) {
      await page.locator('.ws-switcher').click();
      await page.getByRole('menuitemradio', { name: new RegExp(project.name.replace('/', '\\/')) }).click();
      await expect(switcherTitle(page)).toHaveText(project.name);
    }
    await openFromTree(page, canvas.file);
    await expect(page.locator('.ws-canvas .excalidraw')).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await liveScene(page)).ids.sort(), { timeout: 15_000 }).toEqual([...canvas.elementIds].sort());
    const file = await decodeCanvasFile((await storedText(page, project.id, canvas.file))!);
    expect(file.elements.filter((element) => !element.isDeleted).map((element) => element.id).sort()).toEqual([...canvas.elementIds].sort());
    if (canvas.canvasId !== 'main') {
      expect((await liveScene(page)).files).toContain(`${canvas.canvasId === 'pleiades' ? 'pleiades' : 'plan'}-file`);
      expect(Object.keys(file.files)).toEqual([`${canvas.canvasId === 'pleiades' ? 'pleiades' : 'plan'}-file`]);
    }
  }

  // The old canvases are still there, byte for byte, after opening them all.
  const after = await localStorageSnapshot(page);
  for (const canvas of canvases) expect(after[canvas.key], canvas.key).toBe(storage[canvas.key]);
  expect(after['nebula:migration:v2']).toBeTruthy();
  expect(errors).toEqual([]);

  // The note came once; a reload doesn't move anything again.
  await page.reload();
  await page.locator('#loader').waitFor({ state: 'detached' });
  await expect(page.locator('.ws-root')).toBeVisible();
  await expect(page.locator('dialog.ws-welcome')).toHaveCount(0);
  // (What's open is kept in .nebula/workspace.json, which opening them wrote.)
  const contents = (list: typeof projects) => list.map((project) => project.files.filter((path) => path !== '.nebula/workspace.json'));
  expect(contents(await storedProjects(page))).toEqual(contents(projects));
  const again = await localStorageSnapshot(page);
  for (const canvas of canvases) expect(again[canvas.key], canvas.key).toBe(storage[canvas.key]);
});

test('old links open the canvas they named, once it has moved', async ({ page, context }) => {
  const { storage } = legacyFixtures();
  await seedLocalStorage(context, storage);
  await openApp(page);
  await closeIntro(page, 'Got it');

  // /b/<board>/c/<canvas>, as Nebula 1.x wrote them.
  await page.goto('about:blank');
  await openApp(page, '/b/ss-nebula/c/pleiades');
  await expect(page.getByRole('tab', { selected: true })).toHaveText('The Pleiades');
  await expect(page.locator('.ws-canvas .excalidraw')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => new URL(page.url()).pathname).toBe('/app/p/ss-nebula/The%20Pleiades.excalidraw.md');

  // ?board=&canvas=, with a board whose id couldn't be a project's.
  await page.goto('about:blank');
  await openApp(page, `/?board=${encodeURIComponent('board/a')}&canvas=${encodeURIComponent('canvas b')}`);
  await expect(switcherTitle(page)).toHaveText('board/a');
  await expect(page.getByRole('tab', { selected: true })).toHaveText('Plan- phase 1-2');
  await expect(row(page, 'Plan- phase 1-2.excalidraw.md')).toHaveAttribute('aria-selected', 'true');

  // The old /app/ prefix still redirects, and keeps the link.
  await page.goto('about:blank');
  await openApp(page, '/app/b/ss-nebula/c/main');
  await expect(page.getByRole('tab', { selected: true })).toHaveText('Winter hexagon');
});
