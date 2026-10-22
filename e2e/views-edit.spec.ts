import { expect, test, type Page } from '@playwright/test';
import { openFile, openHarness, peek, writeElsewhere, writesTo } from './harness/views-page';

// Lane C: notes and text files save what you do to them.

const NOTE = 'Guides/Observing plan.md';
const CODE = 'src/sky.ts';

/** ⌘E where the page believes it runs on an Apple platform (WebKit's
 * Desktop Safari says Mac OS X even on Linux), Ctrl+E elsewhere. It asks as
 * the page does (isApplePlatform, src/workspace/views/shared/hooks.ts): on a
 * Mac, Desktop Chrome's userAgentData says Windows while navigator.platform
 * still says MacIntel. */
async function editKey(page: Page): Promise<string> {
  const apple = await page.evaluate(() => {
    const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '';
    return /mac|iphone|ipad|ipod/i.test(platform) || /Mac OS X|iPhone|iPad/.test(navigator.userAgent);
  });
  return apple ? 'Meta+e' : 'Control+e';
}

test('a task toggle saves to its own line', async ({ page }) => {
  await openHarness(page, NOTE);
  const before = (await peek(page, NOTE))!;
  const task = page.getByRole('checkbox', { name: /The Pleiades/ });
  await expect(task).not.toBeChecked();
  await task.click();
  await expect(task).toBeChecked();
  await expect.poll(() => peek(page, NOTE)).toContain('- [x] The Pleiades (M45).');
  const after = (await peek(page, NOTE))!;
  const changed = before.split('\n').filter((line, index) => line !== after.split('\n')[index]);
  expect(changed).toEqual(['- [ ] The Pleiades (M45). Binoculars first, then the scope.']);
  await expect(page.getByTestId('saved')).toHaveText('Saved in memory');
});

test('a note edit saves 500 ms after typing stops, and reads back rendered', async ({ page }) => {
  await openHarness(page, NOTE);
  await page.locator('.ws-prose').click();
  await page.keyboard.press(await editKey(page));
  const editor = page.locator('.ws-page .cm-content');
  await expect(editor).toBeVisible({ timeout: 20_000 });
  await expect(editor).toBeFocused();
  await expect(editor).toContainText('Saturday, after moonset.');
  // The frontmatter is part of the source.
  await expect(editor).toContainText('tags: [stargazing, october]');

  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\nClear skies, Bruce.');
  await expect(page.getByTestId('saved')).toHaveText('Unsaved changes');
  await expect.poll(() => peek(page, NOTE), { timeout: 5_000 }).toContain('Clear skies, Bruce.');
  await expect(page.getByTestId('saved')).toHaveText('Saved in memory');
  // One write for the burst, not one per keystroke. (A loaded machine can
  // pause past 500 ms mid-burst; the unit tests pin the exact timing.)
  const writes = await writesTo(page, NOTE);
  expect(writes).toBeGreaterThanOrEqual(1);
  expect(writes).toBeLessThanOrEqual(3);

  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.locator('.ws-prose')).toContainText('Clear skies, Bruce.');
  await expect(page.getByTestId('status')).toHaveText(/^\d+ words$/);
});

test('leaving a note mid-edit saves it at once', async ({ page }) => {
  await openHarness(page, NOTE);
  await page.getByRole('button', { name: 'Edit' }).click();
  const editor = page.locator('.ws-page .cm-content');
  await expect(editor).toBeVisible({ timeout: 20_000 });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\nLast line.');
  await openFile(page, CODE);
  await expect.poll(() => peek(page, NOTE), { timeout: 2_000 }).toContain('Last line.');
});

test('a change elsewhere reloads a clean note, and asks before replacing unsaved edits', async ({ page }) => {
  await openHarness(page, NOTE);
  await writeElsewhere(page, NOTE, '# Replaced\n\nWritten in another tab.\n');
  await expect(page.locator('.ws-prose')).toContainText('Written in another tab.');

  await page.getByRole('button', { name: 'Edit' }).click();
  const editor = page.locator('.ws-page .cm-content');
  await expect(editor).toBeVisible({ timeout: 20_000 });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\nMine.');
  await writeElsewhere(page, NOTE, '# Replaced again\n\nTheirs.\n');
  const bar = page.locator('.ws-conflict');
  await expect(bar).toContainText('Changed elsewhere:');
  await bar.getByRole('button', { name: 'Keep mine' }).click();
  await expect(bar).toHaveCount(0);
  await expect.poll(() => peek(page, NOTE)).toContain('Mine.');

  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' More.');
  await writeElsewhere(page, NOTE, 'Theirs, once more.\n');
  await page.locator('.ws-conflict').getByRole('button', { name: 'Reload' }).click();
  await expect(editor).toContainText('Theirs, once more.');
  await expect(editor).not.toContainText('Mine.');
});

test('a code file edits with its language and saves', async ({ page }) => {
  await openHarness(page, CODE);
  const editor = page.locator('.ws-code-sheet .cm-content');
  await expect(editor).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.ws-code-lang')).toHaveText('TypeScript');
  await expect(page.getByTestId('status')).toHaveText('6 lines');
  // Syntax highlighting: the keyword `export` is its own styled token.
  await expect(editor.locator('span', { hasText: /^export$/ }).first()).toBeVisible();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('export const TWILIGHT = -18;\n');
  await expect.poll(() => peek(page, CODE), { timeout: 5_000 }).toContain('export const TWILIGHT = -18;');
  await expect(page.getByTestId('status')).toHaveText('7 lines');
});
