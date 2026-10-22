import { expect, openApp, row, test } from './app-fixtures';

// The phone layout on the production build, at 390 and 320 wide: the welcome
// as a phone dialog, the top bar and the thumb bar, the files sheet, opening
// a file from it, and Settings as a full-height dialog.

for (const width of [390, 320]) {
  test.describe(`${width} wide`, () => {
    test.use({ appContext: { viewport: { width, height: width === 390 ? 844 : 640 }, hasTouch: true } });

    test('the welcome, the bars, the files sheet and Settings', async ({ page }) => {
      const errors = await openApp(page);

      // The welcome: buttons stacked full width, the main one on top.
      const welcome = page.getByRole('dialog', { name: 'Starscape Nebula' });
      const main = (await welcome.getByRole('button', { name: 'Explore the sample' }).boundingBox())!;
      const other = (await welcome.getByRole('button', { name: 'Start empty' }).boundingBox())!;
      expect(main.y).toBeLessThan(other.y);
      expect(Math.round(main.width)).toBe(Math.round(other.width));
      expect(main.height).toBeGreaterThanOrEqual(44);
      const dialogBox = (await welcome.boundingBox())!;
      expect(dialogBox.x).toBeGreaterThanOrEqual(0);
      expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(width);
      await welcome.getByRole('button', { name: 'Explore the sample' }).click();
      await expect(welcome).toHaveCount(0);

      // A top bar and a thumb bar instead of the rail and tabs.
      await expect(page.locator('.ws-phone-top .ws-phone-title')).toHaveText('Observing plan');
      const bar = page.getByRole('navigation', { name: 'Phone' });
      await expect(bar).toBeVisible();
      await expect(bar.getByRole('button', { name: 'Files' })).toBeVisible();
      await expect(bar.getByRole('button', { name: 'Settings' })).toBeVisible();
      await expect(page.locator('.ws-tabs')).toBeHidden();
      await expect(page.locator('.ws-rail')).toBeHidden();
      await expect(page.locator('.ws-prose')).toContainText('Saturday, after moonset.');
      // Nothing is wider than the screen.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

      // The files sheet opens a file and closes.
      await bar.getByRole('button', { name: 'Files' }).click();
      await expect(page.locator('.ws-root')).toHaveAttribute('data-sheet', '');
      await expect(page.locator('.ws-rail')).toBeVisible();
      await row(page, 'Guides/Orion.md').locator('.page-sidebar-nav-label').click();
      await expect(page.locator('.ws-root')).not.toHaveAttribute('data-sheet', '');
      await expect(page.locator('.ws-phone-title')).toHaveText('Orion');
      await expect(page.locator('.ws-prose')).toBeVisible();

      // Settings: a dialog the height of the screen.
      await bar.getByRole('button', { name: 'Settings' }).click();
      const drawer = page.getByRole('dialog', { name: 'Settings' });
      await expect(drawer).toBeVisible();
      const box = (await drawer.boundingBox())!;
      expect(box.width).toBeGreaterThan(width * 0.75);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      await page.keyboard.press('Escape');
      await expect(drawer).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  });
}
