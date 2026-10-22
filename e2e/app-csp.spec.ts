import { closeIntro, currentProjectId, expect, openApp, pngFile, saved, storedText, test } from './app-fixtures';

// Review finding 20 and the Content-Security-Policy: a canvas opens, draws
// its text in Excalidraw's own fonts, and every font comes from this site
// (/fonts/), not esm.sh. The fixtures fail any test in which the policy
// blocks something or a request leaves the origin; this one drives the parts
// of Excalidraw most likely to need more than the policy allows.

test('a canvas loads Excalidraw’s fonts from this site, and nothing leaves the origin', async ({ page, context }) => {
  const fonts: string[] = [];
  const requests: string[] = [];
  context.on('request', (request) => requests.push(request.url()));
  page.on('response', (response) => {
    if (/\.woff2$/.test(new URL(response.url()).pathname)) fonts.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  const errors = await openApp(page);
  await closeIntro(page);
  await page.getByRole('tab', { name: 'Winter hexagon', exact: true }).click();
  await expect(page.locator('.ws-canvas .excalidraw')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.ws-status')).toContainText(/\d+ elements · \d+%/);

  // The hexagon's labels are in Excalifont: the browser has it, from /fonts/.
  await expect.poll(() => page.evaluate(() => document.fonts.check('20px Excalifont')), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => fonts.filter((entry) => entry.startsWith('200 /fonts/Excalifont/')).length).toBeGreaterThan(0);
  expect(fonts.every((entry) => /^200 \/(fonts|assets)\//.test(entry)), fonts.join('\n')).toBe(true);

  // Select everything, then open what Excalidraw draws over the canvas: the
  // stroke colour picker, the help and the image export.
  const canvas = page.locator('.ws-canvas .excalidraw canvas.interactive');
  const box = (await canvas.boundingBox())!;
  const emptySpot = () => page.mouse.click(box.x + box.width * 0.93, box.y + box.height * 0.55);
  await emptySpot();
  await page.keyboard.press('ControlOrMeta+a');
  await expect(page.locator('.ws-canvas .App-menu__left')).toBeVisible();
  await page.locator('.ws-canvas .App-menu__left button.active-color[aria-label="Stroke"], .ws-canvas .App-menu__left button.active-color[title="Stroke"]').first().click();
  await expect(page.locator('.excalidraw .color-picker-content').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await emptySpot();
  // Excalidraw's dialogs take Escape once focus has moved into them.
  const focusInModal = () => expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('.excalidraw .Modal')))).toBe(true);
  await page.keyboard.press('Shift+?');
  await expect(page.locator('.excalidraw .HelpDialog')).toBeVisible();
  await focusInModal();
  await page.keyboard.press('Escape');
  await expect(page.locator('.excalidraw .HelpDialog')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+Shift+e');
  await expect(page.locator('.excalidraw .ImageExportModal')).toBeVisible();
  await focusInModal();
  await page.keyboard.press('Escape');
  await expect(page.locator('.excalidraw .ImageExportModal')).toHaveCount(0);

  // Mermaid to Excalidraw, the reason the policy allows inline styles.
  await page.locator('.ws-canvas .App-toolbar [data-testid="dropdown-menu-button"]').click();
  await page.locator('.dropdown-menu-item', { hasText: 'Mermaid to Excalidraw' }).click();
  await expect(page.locator('.excalidraw .ttd-dialog')).toBeVisible();
  await expect(page.locator('.excalidraw .ttd-dialog canvas').first()).toBeVisible({ timeout: 15_000 });
  await page.locator('.excalidraw .ttd-dialog button', { hasText: 'Insert' }).first().click();
  await expect(page.locator('.excalidraw .ttd-dialog')).toHaveCount(0);

  expect(requests.filter((url) => !url.startsWith('blob:') && !url.startsWith('data:') && new URL(url).origin !== new URL(page.url()).origin)).toEqual([]);
  expect(errors).toEqual([]);
});

test.describe('in the full browser', () => {
  test.use({ browserChannel: 'chromium' });
  test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium’s full build has the PDF viewer; Playwright’s WebKit draws PDFs itself.');

  test('the PDF viewer works under the policy (object-src none, frames from blob: only)', async ({ page }) => {
    await openApp(page);
    await closeIntro(page);
    await page.locator('.ws-filetree [data-path="Charts"]').click();
    await page.locator('.ws-filetree [data-path="Charts/Star chart — October.pdf"]').click();
    await expect(page.locator('.ws-stage[data-kind="pdf"] iframe')).toBeVisible();
    // The blob: frame hands the file to Chrome's viewer, which loads in a frame of its own.
    await expect.poll(() => page.frames().map((frame) => new URL(frame.url()).protocol)).toEqual(expect.arrayContaining(['blob:', 'chrome-extension:']));
  });
});

// Review finding 20: a web image in a note waits for the reader's click
// (the note view). Once asked, the policy must let it load, or Load images
// would show a broken image on the live site; the lane checked it on the dev
// server, which sends no policy.
test.describe('a web image in a note', () => {
  test.use({ allowOrigins: ['https://images.example'] });

  test('loads once the reader asks, under the policy', async ({ page }) => {
    const asked: string[] = [];
    await page.route(/^https:\/\/images\.example\//, async (route) => {
      asked.push(route.request().url());
      await route.fulfill({ status: 200, contentType: 'image/png', body: pngFile() });
    });
    await openApp(page);
    await closeIntro(page);
    const projectId = currentProjectId(page);
    await page.locator('.ws-section-actions').getByRole('button', { name: 'New note' }).click();
    await page.getByRole('textbox', { name: 'Rename Untitled.md' }).fill('Web image');
    await page.keyboard.press('Enter');
    await page.locator('.ws-stage').getByRole('button', { name: 'Edit' }).click();
    const editor = page.locator('.ws-page .cm-content');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await editor.click();
    await page.keyboard.insertText('![Orion](https://images.example/orion.png)');
    await expect.poll(() => storedText(page, projectId, 'Web image.md'), { timeout: 10_000 }).toBe('![Orion](https://images.example/orion.png)');
    await saved(page);
    await page.locator('.ws-stage').getByRole('button', { name: 'Edit' }).click();

    const prose = page.locator('.ws-prose');
    await expect(prose.locator('.ws-remote-image')).toHaveCount(1);
    expect(asked).toEqual([]);
    await page.locator('.ws-remote-bar').getByRole('button', { name: 'Load images' }).click();
    const image = prose.locator('img');
    await expect(image).toHaveCount(1);
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0)), { timeout: 10_000 }).toBeGreaterThan(0);
    expect(asked).toEqual(['https://images.example/orion.png']);
  });
});

// Re-review R2: the policy allows https: images (for the note's Load images
// above), so a canvas must never hand Excalidraw a remote image: an uploaded
// .excalidraw whose image points at another site would otherwise fetch it
// as soon as it opens. The canvas opens, keeps its image element, and asks
// nothing of that site.
test.describe('a canvas whose image points at another site', () => {
  // Let the request through to the counter below, so a fetch fails here by
  // name rather than in the fixture's off-origin check.
  test.use({ allowOrigins: ['https://tracker.example'] });

  test('opens without fetching it', async ({ page }) => {
    const fetched: string[] = [];
    await page.route(/^https:\/\/tracker\.example\//, async (route) => {
      fetched.push(route.request().url());
      await route.fulfill({ status: 200, contentType: 'image/png', body: pngFile() });
    });
    const crafted = {
      type: 'excalidraw',
      version: 2,
      source: 'https://excalidraw.com',
      elements: [
        {
          id: 'tracker-image',
          type: 'image',
          x: 120,
          y: 120,
          width: 240,
          height: 160,
          angle: 0,
          strokeColor: 'transparent',
          backgroundColor: 'transparent',
          fillStyle: 'solid',
          strokeWidth: 1,
          strokeStyle: 'solid',
          roughness: 1,
          opacity: 100,
          groupIds: [],
          frameId: null,
          roundness: null,
          seed: 1,
          version: 1,
          versionNonce: 1,
          isDeleted: false,
          boundElements: null,
          updated: 1,
          link: null,
          locked: false,
          status: 'saved',
          fileId: 'tracker-file',
          scale: [1, 1],
          crop: null,
        },
      ],
      appState: { viewBackgroundColor: '#ffffff' },
      files: { 'tracker-file': { mimeType: 'image/png', id: 'tracker-file', dataURL: 'https://tracker.example/p.png?u=1', created: 1 } },
    };
    const errors = await openApp(page);
    await closeIntro(page);
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.ws-section-actions').getByRole('button', { name: 'Upload files' }).click();
    await (await chooser).setFiles({ name: 'Crafted.excalidraw', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(crafted)) });
    await page.locator('.ws-filetree [data-path="Crafted.excalidraw"]').click();
    await expect(page.locator('.ws-canvas .excalidraw')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.ws-status')).toContainText(/1 elements? · \d+%/);
    // Excalidraw asks for a scene's images as it draws them: give it time to.
    await page.waitForTimeout(2_000);
    expect(fetched).toEqual([]);
    expect(errors).toEqual([]);
  });
});
