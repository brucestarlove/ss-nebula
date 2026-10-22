import { expect, test } from '@playwright/test';
import { filesReady, openShell, row } from './harness/shell-fixtures';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

async function boxes(page: import('@playwright/test').Page, selector: string) {
  return page.locator(selector).evaluateAll((elements) =>
    elements
      .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { name: element.getAttribute('aria-label') || element.textContent?.trim() || element.className, width: rect.width, height: rect.height };
      }),
  );
}

test.describe('phone', () => {
  test.beforeEach(async ({ page }) => {
    await openShell(page, 'view=probe');
    await page.locator('.ws-phone-top').waitFor();
  });

  test('a top bar and a thumb bar instead of the rail and tabs', async ({ page }) => {
    await expect(page.locator('.ws-phone-top')).toBeVisible();
    await expect(page.locator('.ws-phone-top .ws-phone-title')).toHaveText('Observing plan');
    await expect(page.getByRole('navigation', { name: 'Phone' }).getByRole('button')).toHaveText(['Files', 'Search', '', 'Settings']);
    await expect(page.locator('.ws-tabs')).toBeHidden();
    await expect(page.locator('.ws-status')).toBeHidden();
    await expect(page.locator('.ws-rail')).toBeHidden();
  });

  test('Files opens the rail as a sheet over a scrim; a file opens and the sheet closes', async ({ page }) => {
    await page.getByRole('navigation', { name: 'Phone' }).getByRole('button', { name: 'Files' }).click();
    await expect(page.locator('.ws-root')).toHaveAttribute('data-sheet', '');
    await expect(page.locator('.ws-rail')).toBeVisible();
    await expect(page.locator('.ws-scrim')).toBeVisible();
    await filesReady(page);
    await expect(row(page, 'Guides/Observing plan.md')).toBeFocused();
    await row(page, 'Guides/Orion.md').click();
    await expect(page.locator('.ws-root')).not.toHaveAttribute('data-sheet', '');
    await expect(page.locator('.ws-phone-title')).toHaveText('Orion');
    // Escape and the scrim close it too, and focus comes back.
    const files = page.getByRole('navigation', { name: 'Phone' }).getByRole('button', { name: 'Files' });
    await files.click();
    await expect(page.locator('.ws-rail')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.ws-root')).not.toHaveAttribute('data-sheet', '');
    await expect(files).toBeFocused();
    await files.click();
    await page.locator('.ws-scrim').click({ position: { x: 370, y: 400 } });
    await expect(page.locator('.ws-root')).not.toHaveAttribute('data-sheet', '');
  });

  test('New offers a note, a canvas, a folder or an upload', async ({ page }) => {
    await page.getByRole('button', { name: 'New', exact: true }).click();
    const menu = page.getByRole('menu', { name: 'New' });
    await expect(menu.getByRole('menuitem')).toHaveText(['New note', 'New canvas', 'New folder', 'Upload files…']);
    await menu.getByRole('menuitem', { name: 'New note' }).click();
    await expect(page.locator('.ws-phone-title')).toHaveText('Untitled');
  });

  test('touch targets are 44px or more', async ({ page }) => {
    const small = (list: { name: string | null; width: number; height: number }[]) =>
      list.filter((box) => box.width < 44 || box.height < 44);
    expect(small(await boxes(page, '.ws-phone-top button, .ws-phone-bar button'))).toEqual([]);
    await page.getByRole('navigation', { name: 'Phone' }).getByRole('button', { name: 'Files' }).click();
    await filesReady(page);
    expect(
      small(await boxes(page, '.ws-rail .ws-icon-btn, .ws-rail .ws-search-field, .ws-filetree .page-sidebar-nav-item, .ws-starred .page-sidebar-nav-item')),
    ).toEqual([]);
  });

  test('dialog buttons stack full width, the main one on top', async ({ page }) => {
    await openShell(page, 'intro=welcome&projects=1');
    const dialog = page.getByRole('dialog', { name: 'Starscape Nebula' });
    const main = await dialog.getByRole('button', { name: 'Explore the sample' }).boundingBox();
    const other = await dialog.getByRole('button', { name: 'Start empty' }).boundingBox();
    expect(main!.y).toBeLessThan(other!.y);
    expect(Math.round(main!.width)).toBe(Math.round(other!.width));
    expect(main!.height).toBeGreaterThanOrEqual(44);
  });

  test('Settings opens full height from the thumb bar', async ({ page }) => {
    await page.getByRole('navigation', { name: 'Phone' }).getByRole('button', { name: 'Settings' }).click();
    const drawer = page.getByRole('dialog', { name: 'Settings' });
    await expect(drawer).toBeVisible();
    const box = await drawer.boundingBox();
    expect(box!.width).toBeGreaterThan(300);
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
  });
});
