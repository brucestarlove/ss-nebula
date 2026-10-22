import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { closeIntro, expect, openApp, seedLocalStorage, switcherTitle, test } from './app-fixtures';

// Renders for Bruce from the production build (docs/renders/slice-3/). Runs
// only when NEBULA_RENDERS names a folder for the PNGs, in Chromium:
//   NEBULA_RENDERS=$TMPDIR/renders NEBULA_E2E_BUILT=1 pnpm exec playwright test --project=chromium e2e/app-renders.spec.ts
// The same checks as every app test apply: the policy blocks nothing, and no
// request leaves the site.

const out = process.env.NEBULA_RENDERS;

test.beforeEach(({ browserName }) => {
  test.skip(!out || browserName !== 'chromium', 'Renders: set NEBULA_RENDERS to a folder; Chromium only.');
  mkdirSync(out!, { recursive: true });
});

async function shot(page: Page, name: string) {
  // Let menus and dialogs finish opening, and fonts settle.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out!, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

for (const theme of ['night', 'day'] as const) {
  test(`1440, ${theme}: welcome, note, canvas, Settings, project menu, colours, dock`, async ({ page, context }) => {
    test.setTimeout(120_000);
    await seedLocalStorage(context, { 'nebula:theme': theme === 'night' ? 'dark' : 'light' });
    await openApp(page);
    await expect(page.locator('dialog.ws-welcome')).toBeVisible();
    await shot(page, `welcome-${theme}`);

    await closeIntro(page);
    await expect(page.locator('.ws-prose')).toContainText('Saturday, after moonset.');
    await shot(page, `note-${theme}`);

    await page.getByRole('tab', { name: 'Winter hexagon', exact: true }).click();
    await expect(page.locator('.ws-canvas .excalidraw')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.ws-status')).toContainText(/\d+ elements · \d+%/);
    await expect.poll(() => page.evaluate(() => document.fonts.check('20px Excalifont'))).toBe(true);
    await page.waitForTimeout(1_000);
    await shot(page, `canvas-${theme}`);

    await page.getByRole('tab', { name: 'Observing plan' }).click();
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await shot(page, `settings-project-${theme}`);
    await page.getByRole('tab', { name: 'Appearance' }).click();
    await shot(page, `settings-${theme}`);
    await page.keyboard.press('Escape');

    await page.locator('.ws-switcher').click();
    await expect(page.getByRole('menu', { name: 'Projects' })).toBeVisible();
    await shot(page, `project-menu-${theme}`);
    await page.keyboard.press('Escape');

    await page.locator('.ws-switcher').click({ button: 'right' });
    await expect(page.getByRole('menu', { name: 'Night Sky' })).toBeVisible();
    await shot(page, `colours-${theme}`);
    await page.keyboard.press('Escape');

    // A second project, the dock on, and back to Night Sky.
    await page.locator('.ws-switcher').click();
    await page.getByRole('menuitem', { name: 'New project' }).click();
    const create = page.getByRole('dialog', { name: 'New project' });
    await create.getByRole('textbox', { name: 'Name' }).fill('Field notes');
    await create.getByRole('radio', { name: 'Teal' }).click();
    await create.getByRole('button', { name: 'Create project' }).click();
    await expect(switcherTitle(page)).toHaveText('Field notes');
    await page.locator('.ws-switcher').click();
    await page.getByRole('menuitemcheckbox', { name: 'Dock' }).click();
    await page.keyboard.press('Escape');
    const dock = page.getByRole('navigation', { name: 'Projects' });
    await dock.getByRole('button', { name: 'Night Sky' }).click();
    await expect(switcherTitle(page)).toHaveText('Night Sky');
    await expect(page.locator('.ws-prose')).toContainText('Saturday, after moonset.');
    await page.mouse.move(720, 450);
    await shot(page, `dock-${theme}`);
  });
}

/** A sky drawn in the page (no request leaves the site): a nebula at night,
 * a dawn over hills by day, 2400 × 1500, as PNG bytes. */
async function paintedSky(page: Page, theme: 'night' | 'day'): Promise<Buffer> {
  const url = await page.evaluate((night) => {
    const width = 2400;
    const height = 1500;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d')!;
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const glow = (x: number, y: number, radius: number, colour: string) => {
      const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, colour);
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);
    };
    if (night) {
      context.fillStyle = '#05060f';
      context.fillRect(0, 0, width, height);
      context.globalCompositeOperation = 'lighter';
      glow(1500, 620, 900, 'rgba(120, 60, 200, 0.55)');
      glow(1750, 520, 520, 'rgba(230, 90, 160, 0.45)');
      glow(1280, 820, 620, 'rgba(40, 140, 210, 0.42)');
      glow(1620, 700, 260, 'rgba(255, 200, 150, 0.35)');
      context.globalCompositeOperation = 'source-over';
      for (let star = 0; star < 1400; star += 1) {
        const size = random() ** 6 * 2.6 + 0.4;
        context.fillStyle = `rgba(255, 255, 255, ${0.35 + random() * 0.65})`;
        context.beginPath();
        context.arc(random() * width, random() * height, size, 0, Math.PI * 2);
        context.fill();
      }
    } else {
      const sky = context.createLinearGradient(0, 0, 0, height);
      sky.addColorStop(0, '#f6d8c4');
      sky.addColorStop(0.55, '#fbeee0');
      sky.addColorStop(1, '#e9f0e2');
      context.fillStyle = sky;
      context.fillRect(0, 0, width, height);
      glow(1700, 700, 700, 'rgba(255, 214, 160, 0.7)');
      const hill = (base: number, rise: number, colour: string) => {
        context.fillStyle = colour;
        context.beginPath();
        context.moveTo(0, height);
        for (let x = 0; x <= width; x += 40) context.lineTo(x, base - Math.sin(x / 380 + rise) * 90 - Math.sin(x / 150 + rise * 2) * 24);
        context.lineTo(width, height);
        context.fill();
      };
      hill(1080, 0.4, '#c9d8c0');
      hill(1200, 1.7, '#a9c2a4');
      hill(1330, 2.9, '#8fae8c');
    }
    return canvas.toDataURL('image/png');
  }, theme === 'night');
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
}

for (const theme of ['night', 'day'] as const) {
  test(`1440, ${theme}: Settings backgrounds, a colour and an image`, async ({ page, context }) => {
    test.setTimeout(120_000);
    await seedLocalStorage(context, { 'nebula:theme': theme === 'night' ? 'dark' : 'light' });
    await openApp(page);
    await closeIntro(page);
    await expect(page.locator('.ws-prose')).toContainText('Saturday, after moonset.');
    await page.getByRole('button', { name: 'Settings' }).click();
    const drawer = page.getByRole('dialog', { name: 'Settings' });
    await drawer.getByRole('tab', { name: 'Appearance' }).click();
    const backgrounds = drawer.getByRole('radiogroup', { name: theme === 'night' ? 'Night background' : 'Day background' });

    await backgrounds.getByRole('radio', { name: 'Colour' }).click();
    await drawer
      .getByRole('radiogroup', { name: theme === 'night' ? 'Night background colour' : 'Day background colour' })
      .getByRole('radio', { name: theme === 'night' ? 'Indigo' : 'Sage' })
      .click();
    await shot(page, `bg-colour-${theme}`);

    await backgrounds.getByRole('radio', { name: 'Image' }).click();
    await shot(page, `bg-image-empty-${theme}`);
    const chooser = page.waitForEvent('filechooser');
    await drawer.getByRole('button', { name: 'Choose a background image' }).click();
    await (await chooser).setFiles({ name: 'sky.png', mimeType: 'image/png', buffer: await paintedSky(page, theme) });
    await expect(page.locator('html[data-bg-ready]')).toHaveCount(1, { timeout: 20_000 });
    await shot(page, `bg-image-${theme}`);
    await page.keyboard.press('Escape');
    await shot(page, `bg-image-note-${theme}`);
    await page.getByRole('tab', { name: 'Winter hexagon', exact: true }).click();
    await expect(page.locator('.ws-canvas .excalidraw')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => document.fonts.check('20px Excalifont'))).toBe(true);
    await page.waitForTimeout(1_000);
    await shot(page, `bg-image-canvas-${theme}`);
  });
}

test.describe('390, Settings', () => {
  test.use({ appContext: { viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 } });

  test('the background, a colour and an image', async ({ page, context }) => {
    await seedLocalStorage(context, { 'nebula:theme': 'dark' });
    await openApp(page);
    await closeIntro(page);
    await page.getByRole('navigation', { name: 'Phone' }).getByRole('button', { name: 'Settings' }).click();
    const drawer = page.getByRole('dialog', { name: 'Settings' });
    await shot(page, 'phone-settings-project-night');
    await drawer.getByRole('tab', { name: 'Appearance' }).click();
    const backgrounds = drawer.getByRole('radiogroup', { name: 'Night background' });
    await backgrounds.getByRole('radio', { name: 'Colour' }).click();
    await shot(page, 'phone-bg-colour-night');
    await backgrounds.getByRole('radio', { name: 'Image' }).click();
    const chooser = page.waitForEvent('filechooser');
    await drawer.getByRole('button', { name: 'Choose a background image' }).click();
    await (await chooser).setFiles({ name: 'sky.png', mimeType: 'image/png', buffer: await paintedSky(page, 'night') });
    await expect(page.locator('html[data-bg-ready]')).toHaveCount(1, { timeout: 20_000 });
    await shot(page, 'phone-bg-image-night');
  });
});

test.describe('390, night', () => {
  test.use({ appContext: { viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 } });

  test('the note and the files sheet', async ({ page, context }) => {
    await seedLocalStorage(context, { 'nebula:theme': 'dark' });
    await openApp(page);
    await closeIntro(page);
    await expect(page.locator('.ws-prose')).toContainText('Saturday, after moonset.');
    await shot(page, 'phone-note-night');
    await page.getByRole('navigation', { name: 'Phone' }).getByRole('button', { name: 'Files' }).click();
    await expect(page.locator('.ws-rail')).toBeVisible();
    await shot(page, 'phone-files-night');
  });
});
