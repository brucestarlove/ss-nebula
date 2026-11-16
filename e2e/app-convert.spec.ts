import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { closeIntro, expect, openApp, row, test, uploadFiles } from './app-fixtures';

/**
 * Convert image… in a real browser (Bruce, 2026-10-25: Obsidian's Image
 * Converter, "change format to webp and maybe change image resolution"):
 * the browser's own decoder and encoder, checked by the bytes they write.
 */

/** A 1600 × 1200 picture with gradients and grain, as a PNG: big, like a screenshot or a photo saved as PNG. */
async function photoPng(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1600;
    canvas.height = 1200;
    const context = canvas.getContext('2d')!;
    const sky = context.createLinearGradient(0, 0, 0, 1200);
    sky.addColorStop(0, '#0b1d51');
    sky.addColorStop(0.6, '#7c3f8c');
    sky.addColorStop(1, '#f6a96b');
    context.fillStyle = sky;
    context.fillRect(0, 0, 1600, 1200);
    const pixels = context.getImageData(0, 0, 1600, 1200);
    let seed = 7;
    for (let at = 0; at < pixels.data.length; at += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const grain = (seed % 25) - 12;
      pixels.data[at] += grain;
      pixels.data[at + 1] += grain;
      pixels.data[at + 2] += grain;
    }
    context.putImageData(pixels, 0, 0);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((made) => resolve(made!), 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  });
  return Buffer.from(base64, 'base64');
}

async function canWriteWebP(page: Page): Promise<boolean> {
  return page.evaluate(
    () => new Promise<boolean>((resolve) => document.createElement('canvas').toBlob((blob) => resolve(blob?.type === 'image/webp'), 'image/webp')),
  );
}

async function convertFromTree(page: Page, path: string, label = 'Convert image…') {
  await row(page, path).click({ button: 'right' });
  await page.getByRole('menu', { name: 'File' }).getByRole('menuitem', { name: label }).click();
  const dialog = page.locator('dialog.ws-convert');
  await expect(dialog).toBeVisible();
  return dialog;
}

async function downloaded(page: Page, path: string): Promise<Buffer> {
  await row(page, path).click({ button: 'right' });
  const download = page.waitForEvent('download');
  await page.getByRole('menu', { name: 'File' }).getByRole('menuitem', { name: 'Download', exact: true }).click();
  return readFile((await (await download).path())!);
}

test('converts a PNG to a smaller WebP (or JPEG where the browser can’t write WebP), at the size asked for', async ({ page }) => {
  const errors = await openApp(page);
  await closeIntro(page);
  const png = await photoPng(page);
  await uploadFiles(page, [{ name: 'Sky.png', mimeType: 'image/png', buffer: png }]);
  const webp = await canWriteWebP(page);

  const dialog = await convertFromTree(page, 'Sky.png');
  await expect(dialog).toContainText('PNG · 1,600 × 1,200 px');
  const formats = dialog.getByRole('radiogroup', { name: 'Format' }).getByRole('radio');
  if (webp) {
    await expect(formats).toHaveText(['WebP', 'JPEG', 'PNG']);
    await expect(dialog.getByRole('radio', { name: 'WebP' })).toHaveAttribute('aria-checked', 'true');
  } else {
    await expect(formats).toHaveText(['JPEG', 'PNG']);
    await expect(dialog).toContainText('This browser can’t write WebP. Chrome, Edge and Firefox can.');
  }
  // Only sizes smaller than the image are offered.
  await expect(dialog.getByRole('radiogroup', { name: 'Longest side' }).getByRole('radio')).toHaveText(['As it is', '1,280', '800']);
  await dialog.getByRole('radio', { name: '1,280' }).click();
  await expect(dialog.locator('.ws-convert-estimate')).toContainText(/^1,280 × 960 px · [\d.]+ MB → [\d.]+ KB, \d+% smaller$/, { timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Convert', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const name = webp ? 'Sky.webp' : 'Sky.jpg';
  await expect(row(page, name)).toBeVisible();
  await expect(row(page, 'Sky.png')).toBeVisible();
  await expect(page.locator('.ws-status')).toContainText(`Saved “${name}” next to “Sky.png”`);
  const bytes = await downloaded(page, name);
  if (webp) {
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString('latin1')).toBe('WEBP');
  } else {
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  }
  expect(bytes.length).toBeLessThan(png.length / 4);

  // The browser opens what was written, at the new size.
  await row(page, name).click();
  await expect(page.locator('.ws-status')).toContainText('1,280 × 960 px');
  expect(errors).toEqual([]);
});

test('replacing: the new file goes in under a free name, then the original goes', async ({ page }) => {
  const errors = await openApp(page);
  await closeIntro(page);
  const png = await photoPng(page);
  await uploadFiles(page, [{ name: 'Sky.png', mimeType: 'image/png', buffer: png }]);
  const name = (await canWriteWebP(page)) ? 'Sky.webp' : 'Sky.jpg';

  // The first time keeps the original; the second replaces it, and the name is taken by then.
  let dialog = await convertFromTree(page, 'Sky.png');
  await dialog.getByRole('button', { name: 'Convert', exact: true }).click();
  await expect(row(page, name)).toBeVisible();
  dialog = await convertFromTree(page, 'Sky.png');
  await dialog.getByRole('radio', { name: 'Replace it' }).click();
  await expect(dialog).toContainText(`“Sky.png” goes, and “${name}” takes its place.`);
  await dialog.getByRole('button', { name: 'Convert', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const second = name.replace('.', ' 2.');
  await expect(row(page, second)).toBeVisible();
  await expect(row(page, name)).toBeVisible();
  await expect(row(page, 'Sky.png')).toHaveCount(0);
  await expect(page.locator('.ws-status')).toContainText(`Replaced “Sky.png” with “${second}”`);
  expect(errors).toEqual([]);
});
