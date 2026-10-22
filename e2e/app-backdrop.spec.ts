import type { BrowserContext, Locator, Page } from '@playwright/test';
import { closeIntro, expect, failOpfs, openApp, pngFile, test } from './app-fixtures';

// Settings and backgrounds (Bruce, 2026-10-22; docs/slice-3.md): the drawer
// is titled Settings and opens on Project, before Appearance; each theme's
// background is its own sky, a colour of your choosing, or an image of your
// own, kept in this browser. Runs under the site's Content-Security-Policy,
// and the fixtures fail any test that leaves the origin.

type Shown = { bg: string | null; ready: boolean; colour: string; image: string; fade: string };

async function shown(page: Page): Promise<Shown> {
  return page.evaluate(() => {
    const root = document.documentElement;
    return {
      bg: root.dataset.bg ?? null,
      ready: root.hasAttribute('data-bg-ready'),
      colour: getComputedStyle(document.body).backgroundColor,
      image: getComputedStyle(document.body, '::before').backgroundImage,
      fade: root.style.getPropertyValue('--nebula-bg-fade'),
    };
  });
}

/** Settings, on Appearance: it opens on Project the first time. */
async function appearance(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Settings' }).click();
  const drawer = page.getByRole('dialog', { name: 'Settings' });
  await expect(drawer.getByRole('tab', { name: 'Project' })).toHaveAttribute('aria-selected', 'true');
  await drawer.getByRole('tab', { name: 'Appearance' }).click();
  return drawer;
}

/** A 4000 × 2400 PNG, a sky at dusk, drawn in the page. */
async function bigSky(page: Page): Promise<Buffer> {
  const url = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 4000;
    canvas.height = 2400;
    const context = canvas.getContext('2d')!;
    const sky = context.createLinearGradient(0, 0, 4000, 2400);
    sky.addColorStop(0, '#1d2671');
    sky.addColorStop(0.55, '#c33764');
    sky.addColorStop(1, '#f6d365');
    context.fillStyle = sky;
    context.fillRect(0, 0, 4000, 2400);
    return canvas.toDataURL('image/png');
  });
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
}

/** The browser tier's appearance folder: each file, and its image's size. */
async function appearanceFiles(page: Page): Promise<Array<{ name: string; width: number; height: number }>> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    let folder: FileSystemDirectoryHandle;
    try {
      folder = await (await root.getDirectoryHandle('nebula')).getDirectoryHandle('appearance');
    } catch {
      return [];
    }
    const files: Array<{ name: string; width: number; height: number }> = [];
    for await (const handle of (folder as FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> }).values()) {
      if (handle.kind !== 'file') continue;
      const bitmap = await createImageBitmap(await (handle as FileSystemFileHandle).getFile()).catch(() => null);
      files.push({ name: handle.name, width: bitmap?.width ?? 0, height: bitmap?.height ?? 0 });
      bitmap?.close();
    }
    return files;
  });
}

async function chooseImage(page: Page, drawer: Locator, file: { name: string; mimeType: string; buffer: Buffer }) {
  const chooser = page.waitForEvent('filechooser');
  await drawer.getByRole('button', { name: 'Choose a background image' }).click();
  await (await chooser).setFiles(file);
  await expect(drawer.getByRole('button', { name: 'Replace the background image' })).toBeVisible({ timeout: 20_000 });
}

test('Settings is titled Settings, and opens on Project, before Appearance', async ({ page }) => {
  const errors = await openApp(page);
  await closeIntro(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  const drawer = page.getByRole('dialog', { name: 'Settings' });
  await expect(drawer.getByRole('tab')).toHaveText(['Project', 'Appearance']);
  await expect(drawer.getByRole('tab', { name: 'Project' })).toHaveAttribute('aria-selected', 'true');
  await expect(drawer.locator('.drawer-header')).not.toContainText('Nebula');
  expect(errors).toEqual([]);
});

test('a colour of your own at night, kept over a reload, while the day keeps its parchment', async ({ page }) => {
  const errors = await openApp(page);
  await closeIntro(page);
  const drawer = await appearance(page);
  await drawer.getByRole('radio', { name: 'Night', exact: true }).click();
  await drawer.getByRole('radiogroup', { name: 'Night background' }).getByRole('radio', { name: 'Colour' }).click();
  // The motion switch belongs to the starfield, and goes with it.
  await expect(drawer.getByText('Animated background')).toHaveCount(0);
  await drawer.getByRole('radiogroup', { name: 'Night background colour' }).getByRole('radio', { name: 'Indigo' }).click();
  await expect.poll(() => shown(page)).toMatchObject({ bg: 'black', colour: 'rgb(27, 23, 71)' });
  await drawer.getByLabel('Any colour').fill('#123456');
  await expect.poll(() => shown(page)).toMatchObject({ bg: 'black', colour: 'rgb(18, 52, 86)' });

  await page.reload();
  await page.locator('#loader').waitFor({ state: 'detached' });
  expect(await shown(page)).toMatchObject({ bg: 'black', colour: 'rgb(18, 52, 86)' });
  const again = await appearance(page);
  await again.getByRole('radio', { name: 'Day', exact: true }).click();
  await expect.poll(async () => (await shown(page)).bg).toBe('parchment');
  await expect(again.getByRole('radiogroup', { name: 'Day background' }).getByRole('radio', { name: 'Parchment' })).toHaveAttribute('aria-checked', 'true');
  expect(errors).toEqual([]);
});

test('an image of your own: scaled down, kept in this browser, painted from its preview at once on the next load', async ({ page }) => {
  // What <html> shows before the app starts, on every load from here on.
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const root = document.documentElement;
      (window as Window & { __firstPaint?: unknown }).__firstPaint = {
        bg: root.dataset.bg ?? null,
        preview: root.style.getPropertyValue('--nebula-bg-thumb').startsWith('url("data:image/jpeg;base64,'),
      };
    });
  });
  const errors = await openApp(page);
  await closeIntro(page);
  const drawer = await appearance(page);
  await drawer.getByRole('radio', { name: 'Night', exact: true }).click();
  await drawer.getByRole('radiogroup', { name: 'Night background' }).getByRole('radio', { name: 'Image' }).click();
  await expect(drawer).toContainText('Kept in this browser, on this device.');
  await chooseImage(page, drawer, { name: 'Dusk.png', mimeType: 'image/png', buffer: await bigSky(page) });
  await expect.poll(() => shown(page), { timeout: 10_000 }).toMatchObject({ bg: 'image', ready: true });
  expect((await shown(page)).image).toMatch(/url\("blob:/);

  // Scaled to 3200 px on its long side, as a JPEG, and nothing else there.
  expect(await appearanceFiles(page)).toEqual([{ name: expect.stringMatching(/^night-[a-z0-9]+\.jpg$/), width: 3200, height: 1920 }]);
  const preview = await page.evaluate(() => localStorage.getItem('nebula:bg-dark-thumb'));
  expect(preview).toMatch(/^data:image\/jpeg;base64,/);
  expect(preview!.length).toBeLessThan(16_384);

  // Fade, from the keyboard: 30 % to 60 %.
  const fade = drawer.getByRole('slider', { name: 'Fade' });
  await fade.focus();
  for (let step = 0; step < 6; step += 1) await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await shown(page)).fade).toBe('0.6');

  await page.reload();
  await page.locator('#loader').waitFor({ state: 'detached' });
  expect(await page.evaluate(() => (window as Window & { __firstPaint?: unknown }).__firstPaint)).toEqual({ bg: 'image', preview: true });
  await expect.poll(() => shown(page), { timeout: 10_000 }).toMatchObject({ bg: 'image', ready: true, fade: '0.6' });

  // Remove: gone from the browser, and the colour shows on Image's empty tile.
  const settings = await appearance(page);
  await settings.getByRole('button', { name: 'Remove' }).click();
  await expect.poll(() => appearanceFiles(page)).toEqual([]);
  await expect.poll(() => shown(page)).toMatchObject({ bg: 'black', ready: false, colour: 'rgb(0, 0, 0)' });
  await expect(settings.getByRole('button', { name: 'Choose a background image' })).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe('a browser that keeps nothing', () => {
  test.use({ ephemeral: true });

  async function keepNothing(context: BrowserContext, browserName: string) {
    // Chromium keeps OPFS in any context: make it fail the way WebKit's does.
    if (browserName === 'chromium') await failOpfs(context);
  }

  test('an image lasts for the tab, and Settings says so', async ({ page, context, browserName }) => {
    await keepNothing(context, browserName);
    const errors = await openApp(page);
    await closeIntro(page);
    const drawer = await appearance(page);
    await drawer.getByRole('radio', { name: 'Night', exact: true }).click();
    await drawer.getByRole('radiogroup', { name: 'Night background' }).getByRole('radio', { name: 'Image' }).click();
    await expect(drawer).toContainText('This browser can’t keep files here, so the image lasts until this tab closes.');
    await expect(drawer).not.toContainText('Kept in this browser');
    await chooseImage(page, drawer, { name: 'Tiny.png', mimeType: 'image/png', buffer: pngFile() });
    await expect.poll(() => shown(page), { timeout: 10_000 }).toMatchObject({ bg: 'image', ready: true });
    expect(errors).toEqual([]);
  });
});
