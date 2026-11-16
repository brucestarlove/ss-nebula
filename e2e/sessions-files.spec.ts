import { readFile } from 'node:fs/promises';
import { BROKEN_TEXT, CRLF_TEXT, expect, files, openPath, openSessions, PATHS, row, shoot, test } from './harness/sessions-test';

// What a file is shown as, what the workspace says about where it's kept,
// and what leaves the page, on
// the real OPFS store. Screenshots go to $TMPDIR/sessions-shots.

const PHONE = { width: 390, height: 844 };

test('New project says plainly when this browser keeps nothing', async ({ page, browserName }) => {
  await openSessions(page, `file=${encodeURIComponent(PATHS.note)}&persistent=0`);
  await page.locator('.ws-switcher').click();
  await page.getByRole('menuitem', { name: 'New project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await expect(dialog).toContainText('This browser can’t keep files here, so its files last until you close this tab.');
  await expect(dialog).not.toContainText('saved in this browser');
  await shoot(page, `new-project-ephemeral-1440-${browserName}`);
  await page.setViewportSize(PHONE);
  await expect(dialog).toBeVisible();
  await shoot(page, `new-project-ephemeral-390-${browserName}`);
});

test('New project, where the browser keeps files', async ({ page, browserName }) => {
  await openSessions(page, `file=${encodeURIComponent(PATHS.note)}`);
  await page.locator('.ws-switcher').click();
  await page.getByRole('menuitem', { name: 'New project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await expect(dialog).toContainText('Its files are saved in this browser, on this device.');
  await shoot(page, `new-project-persistent-1440-${browserName}`);
});

test('a canvas that won’t open offers to open as a note, and nothing is written', async ({ page, browserName }) => {
  const errors = await openSessions(page, `file=${encodeURIComponent(PATHS.broken)}`);
  const card = page.locator('.ws-info-card');
  await expect(card).toBeVisible({ timeout: 30_000 });
  const open = card.getByRole('button', { name: 'Open as note' });
  await expect(open).toBeVisible();
  await expect(card.getByRole('button', { name: 'Download' })).toBeVisible();
  await shoot(page, `canvas-error-1440-${browserName}`);
  await page.setViewportSize(PHONE);
  await shoot(page, `canvas-error-390-${browserName}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open.click();
  await expect(page.locator('.ws-stage[data-kind="note"] .ws-prose')).toContainText('Just words, kept safe.');
  await page.waitForTimeout(1_000);
  expect(await files.read(page, PATHS.broken)).toBe(BROKEN_TEXT);
  expect(await files.writes(page, PATHS.broken)).toBe(0);
  expect(errors).toEqual([]);
});

test('the file menu’s Download hands out opaque bytes and keeps its URL a while', async ({ page }) => {
  await page.addInitScript(() => {
    const made: Array<{ url: string; type: string }> = [];
    const revoked: Array<{ url: string; at: number }> = [];
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = create(object);
      made.push({ url, type: object instanceof Blob ? object.type : 'media' });
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      revoked.push({ url, at: performance.now() });
      revoke(url);
    };
    (window as unknown as { __blobs: unknown }).__blobs = { made, revoked };
  });
  await openSessions(page, `file=${encodeURIComponent(PATHS.note)}`);
  await row(page, PATHS.moon).locator('.page-sidebar-nav-label').click({ button: 'right' });
  const download = page.waitForEvent('download');
  const before = await page.evaluate(() => (window as unknown as { __blobs: { made: unknown[] } }).__blobs.made.length);
  await page.getByRole('menuitem', { name: 'Download' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^Moon[ _]phases\.md$/);
  expect(await readFile((await file.path())!, 'utf8')).toBe('# Moon phases\n\nNew moon on the 9th.\n');
  const blobs = await page.evaluate(() => (window as unknown as { __blobs: { made: Array<{ url: string; type: string }>; revoked: Array<{ url: string }> } }).__blobs);
  const made = blobs.made.slice(before);
  expect(made.map((blob) => blob.type)).toEqual(['application/octet-stream']);
  await page.waitForTimeout(2_000);
  const revokedNow = await page.evaluate(() => (window as unknown as { __blobs: { revoked: Array<{ url: string }> } }).__blobs.revoked.map((item) => item.url));
  expect(revokedNow).not.toContain(made[0].url);
});

test('text that isn’t UTF-8 opens read-only, with Download, and is never written', async ({ page, browserName }) => {
  const errors = await openSessions(page, `file=${encodeURIComponent(PATHS.latin1)}`);
  const before = await files.bytes(page, PATHS.latin1);
  const bar = page.locator('.ws-conflict');
  await expect(bar).toContainText('Read-only: this file isn’t UTF-8 text, so saving it here would change its bytes.');
  await expect(bar.getByRole('button', { name: 'Download' })).toBeVisible();
  const editor = page.locator('.cm-content');
  await expect(editor).toHaveAttribute('contenteditable', 'false');
  await shoot(page, `read-only-text-1440-${browserName}`);
  await page.setViewportSize(PHONE);
  await shoot(page, `read-only-text-390-${browserName}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await editor.click();
  await page.keyboard.type('typed');
  await page.waitForTimeout(1_200);
  await expect(editor).not.toContainText('typed');
  expect(await files.bytes(page, PATHS.latin1)).toEqual(before);
  expect(await files.writes(page, PATHS.latin1)).toBe(0);

  await openPath(page, PATHS.latin1Note);
  await expect(page.locator('.ws-note .ws-conflict')).toContainText('Read-only');
  // No Edit; the page width switch stays, since reading width still applies.
  await expect(page.locator('.ws-page-tools [aria-label="Edit"]')).toHaveCount(0);
  await shoot(page, `read-only-note-1440-${browserName}`);
  const task = page.locator('.ws-prose input[type="checkbox"]').first();
  if ((await task.count()) > 0) await task.click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(1_000);
  expect(await files.writes(page, PATHS.latin1Note)).toBe(0);
  expect(errors).toEqual([]);
});

test('a CRLF file keeps CRLF when edited, and isn’t written back when it changes elsewhere', async ({ page }) => {
  await openSessions(page, `file=${encodeURIComponent(PATHS.crlf)}`);
  const editor = page.locator('.cm-content');
  await expect(editor).toContainText('Collimate before the Orionids.');
  await page.waitForTimeout(1_200);
  expect(await files.writes(page, PATHS.crlf)).toBe(0);

  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('Pack the dew shield.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Check the forecast.');
  await expect.poll(() => files.read(page, PATHS.crlf), { timeout: 5_000 }).toContain('Check the forecast.');
  const saved = (await files.read(page, PATHS.crlf))!;
  expect(saved).toBe(`${CRLF_TEXT}Pack the dew shield.\r\nCheck the forecast.`);
  expect(saved.replace(/\r\n/g, '')).not.toContain('\n');

  // Changed elsewhere, with CRLF: shown, and not written back.
  const writes = await files.writes(page, PATHS.crlf);
  await files.write(page, PATHS.crlf, 'From another app.\r\nStill CRLF.\r\n');
  await expect(editor).toContainText('Still CRLF.', { timeout: 5_000 });
  await page.waitForTimeout(1_500);
  expect(await files.writes(page, PATHS.crlf)).toBe(writes);
  expect(await files.read(page, PATHS.crlf)).toBe('From another app.\r\nStill CRLF.\r\n');
});

test('uploads with awkward names go in under safe names, and one that can’t doesn’t stop the rest', async ({ page }) => {
  await openSessions(page, `file=${encodeURIComponent(PATHS.note)}`);
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles([
    { name: 'one.txt', mimeType: 'text/plain', buffer: Buffer.from('1') },
    { name: 'back\\slash.txt', mimeType: 'text/plain', buffer: Buffer.from('2') },
    { name: '.nebula', mimeType: 'text/plain', buffer: Buffer.from('3') },
    { name: 'three.txt', mimeType: 'text/plain', buffer: Buffer.from('4') },
  ]);
  const status = page.locator('.ws-status');
  await expect(status).toContainText('Couldn’t add', { timeout: 5_000 });
  await expect(status).toContainText('Added 3 files.');
  await expect(status).toContainText('“.nebula”');
  const paths = await files.paths(page);
  expect(paths).toEqual(expect.arrayContaining(['one.txt', 'three.txt']));
  expect(paths.some((path) => /^back.slash\.txt$/.test(path) && !path.includes('\\'))).toBe(true);
});

test('Settings says whether the browser has agreed to keep the files', async ({ page, browserName }) => {
  await openSessions(page, `file=${encodeURIComponent(PATHS.note)}`);
  await expect(page.locator('.ws-status')).toContainText('Saved in this browser');
  const persisted = await page.evaluate(() => navigator.storage.persisted());
  await page.locator('.ws-rail [aria-label="Settings"]').click();
  await page.locator('#ws-settings-tab-project').click();
  const panel = page.locator('#ws-settings-panel-project');
  await expect(panel).toContainText(
    persisted ? 'This browser has agreed to keep Nebula’s files, even when space runs low.' : 'This browser may clear Nebula’s files when space runs low',
  );
  await shoot(page, `settings-storage-1440-${browserName}`);
  await page.setViewportSize(PHONE);
  await expect(panel).toBeVisible();
  await shoot(page, `settings-storage-390-${browserName}`);
});

test('web images in a note wait for a click; the project’s own aren’t touched', async ({ page, browserName }) => {
  const asked: string[] = [];
  const png = await readFile('sketches/workspace/assets/nebula-logo.png');
  await page.route(/^https:\/\/(tracker|charts)\.example\//, async (route) => {
    asked.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'image/png', body: png });
  });
  await openSessions(page, `file=${encodeURIComponent(PATHS.web)}`);
  const prose = page.locator('.ws-prose');
  await expect(prose).toContainText('A tracking pixel:');
  await expect(prose.locator('.ws-remote-image')).toHaveText(['Pixel · tracker.example', 'Orion, from the web · charts.example']);
  await expect(prose.locator('img')).toHaveCount(0);
  const bar = page.locator('.ws-remote-bar');
  await expect(bar).toContainText('Web images in this note load only when you ask.');
  await page.waitForTimeout(1_000);
  expect(asked).toEqual([]);
  await shoot(page, `web-images-held-1440-${browserName}`);
  await page.setViewportSize(PHONE);
  await expect(bar).toBeVisible();
  await shoot(page, `web-images-held-390-${browserName}`);
  await page.setViewportSize({ width: 1440, height: 900 });

  await bar.getByRole('button', { name: 'Load images' }).click();
  await expect(prose.locator('img')).toHaveCount(2);
  await expect.poll(() => asked.length, { timeout: 5_000 }).toBe(2);
  await expect(bar).toHaveCount(0);
  // The project's own image isn't in this harness project: its words stand in, muted.
  await expect(prose.locator('.ws-embed-missing')).toHaveText('Winter hexagon');
  await shoot(page, `web-images-loaded-1440-${browserName}`);
});
