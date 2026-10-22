import { closeIntro, expect, openApp, openFromTree, pngFile, test, uploadFiles, videoFile, wavFile } from './app-fixtures';

// Every kind of file opens in a tab with its own view (PLAN §5.4): the
// sample's note, canvas, image and PDF, and uploaded text, code, audio,
// video and a file Nebula has no view for.

test('every kind of file opens in its view', async ({ page }) => {
  const errors = await openApp(page);
  await closeIntro(page);
  await uploadFiles(page, [
    { name: 'Moon log.txt', mimeType: 'text/plain', buffer: Buffer.from('Waxing gibbous, 78%.\nSeeing 3/5.\n') },
    { name: 'sky.ts', mimeType: 'text/plain', buffer: Buffer.from('export const darkAdaptation = 20 * 60; // seconds\n') },
    { name: 'Crickets at dusk.wav', mimeType: 'audio/wav', buffer: wavFile() },
    { name: 'Moonrise.webm', mimeType: 'video/webm', buffer: videoFile('webm') },
    { name: 'Moonrise.mp4', mimeType: 'video/mp4', buffer: videoFile('mp4') },
    { name: 'Backup.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 159, 146, 150, 1, 2, 3]) },
    { name: 'Andromeda.png', mimeType: 'image/png', buffer: pngFile() },
  ]);

  const stage = (kind: string) => page.locator(`.ws-stage[data-kind="${kind}"]`);

  await openFromTree(page, 'Guides/Orion.md');
  await expect(stage('note').locator('.ws-prose')).toBeVisible();

  await openFromTree(page, 'Sketches/Winter hexagon.excalidraw.md');
  await expect(stage('canvas').locator('.excalidraw')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.ws-status')).toContainText(/\d+ elements · \d+%/);

  for (const path of ['Photos/Winter hexagon.png', 'Andromeda.png']) {
    await openFromTree(page, path);
    const image = stage('image').locator('img');
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth), { message: path }).toBeGreaterThan(0);
    await expect(page.locator('.ws-status')).toContainText(' px');
  }

  await openFromTree(page, 'Charts/Star chart — October.pdf');
  await expect(stage('pdf').locator('iframe')).toHaveAttribute('src', /^blob:/);
  await expect(stage('pdf').getByRole('link', { name: 'Open in new tab' })).toBeVisible();

  for (const path of ['Moon log.txt', 'sky.ts']) {
    await openFromTree(page, path);
    await expect(stage('text').locator('.cm-content'), path).toBeVisible({ timeout: 20_000 });
  }
  await expect(stage('text').locator('.cm-content')).toContainText('darkAdaptation');

  await openFromTree(page, 'Crickets at dusk.wav');
  await expect.poll(() => stage('audio').locator('audio').evaluate((node: HTMLMediaElement) => node.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await expect(page.locator('.ws-status')).toContainText('0:01');

  // A browser that can't play a format says so on the info card instead.
  for (const path of ['Moonrise.webm', 'Moonrise.mp4']) {
    await openFromTree(page, path);
    await expect(stage('video').locator('video, .ws-info-card').first(), path).toBeVisible({ timeout: 15_000 });
    if (await stage('video').locator('.ws-info-card').count()) await expect(stage('video').locator('.ws-info-card')).toContainText('can’t play');
    else await expect(page.locator('.ws-status'), path).toContainText('0:02', { timeout: 15_000 });
  }

  await openFromTree(page, 'Backup.bin');
  await expect(stage('other').locator('.ws-info-card')).toBeVisible();
  await expect(stage('other').getByRole('button', { name: /Download/ })).toBeVisible();
  expect(errors).toEqual([]);
});
