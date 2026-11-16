import { drawRectangle, expect, files, openSessions, PATHS, shownElements, test } from './harness/sessions-test';

// Two tabs on one canvas, on the real OPFS store and
// BroadcastChannel: a clean tab follows the other's save; a tab with its own
// change asks before writing over it, even when the other tab's message is
// slow to arrive.

const CANVAS = `file=${encodeURIComponent(PATHS.empty)}`;

test('a clean tab follows a drawing saved in another tab', async ({ page, context }) => {
  await openSessions(page, CANVAS);
  const other = await context.newPage();
  await openSessions(other, CANVAS);
  expect(await shownElements(page)).toBe(0);
  expect(await shownElements(other)).toBe(0);

  await drawRectangle(other, { x: 0.5, y: 0.4 });
  await expect.poll(async () => (await files.scene(page, PATHS.empty))?.ids.length ?? 0, { timeout: 5_000 }).toBe(1);
  await expect.poll(() => shownElements(page), { timeout: 5_000 }).toBe(1);
  await expect(page.locator('.ws-conflict')).toHaveCount(0);
  // Following isn't a change of its own: nothing is written back.
  await page.waitForTimeout(1_000);
  expect(await files.writes(page, PATHS.empty)).toBe(0);
});

test('a tab with its own change asks before writing over another tab’s save it hasn’t heard about', async ({ page, context }) => {
  // This tab hears the other tabs 4 s late, as a busy browser might.
  await page.addInitScript(() => {
    const Late = 4_000;
    const Original = window.BroadcastChannel;
    class LateChannel extends Original {
      set onmessage(listener: ((event: MessageEvent) => void) | null) {
        super.onmessage = listener && ((event: MessageEvent) => setTimeout(() => listener.call(this, event), Late));
      }
      addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
        if (type !== 'message' || typeof listener !== 'function') return super.addEventListener(type, listener, options);
        return super.addEventListener(type, (event) => setTimeout(() => listener.call(this, event), Late), options);
      }
    }
    window.BroadcastChannel = LateChannel;
  });
  await openSessions(page, CANVAS);
  const other = await context.newPage();
  await openSessions(other, CANVAS);
  expect(await shownElements(page)).toBe(0);
  expect(await shownElements(other)).toBe(0);

  await drawRectangle(other, { x: 0.3, y: 0.4 });
  await expect.poll(async () => (await files.scene(other, PATHS.empty))?.ids.length ?? 0, { timeout: 5_000 }).toBe(1);
  const theirs = (await files.scene(other, PATHS.empty))!.ids;

  await drawRectangle(page, { x: 0.7, y: 0.4 });
  const bar = page.locator('.ws-conflict');
  await expect(bar).toContainText(/changed elsewhere/i, { timeout: 5_000 });
  await expect(bar.getByRole('button', { name: 'Reload' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Keep mine' })).toBeVisible();
  expect((await files.scene(page, PATHS.empty))!.ids).toEqual(theirs);

  await bar.getByRole('button', { name: 'Keep mine' }).click();
  await expect.poll(async () => (await files.scene(page, PATHS.empty))?.ids.filter((id) => !theirs.includes(id)).length ?? 0, { timeout: 5_000 }).toBe(1);
  await expect(bar).toHaveCount(0);
});

test('Reload takes the other tab’s drawing instead', async ({ page, context }) => {
  await page.addInitScript(() => {
    const Original = window.BroadcastChannel;
    class LateChannel extends Original {
      set onmessage(listener: ((event: MessageEvent) => void) | null) {
        super.onmessage = listener && ((event: MessageEvent) => setTimeout(() => listener.call(this, event), 4_000));
      }
    }
    window.BroadcastChannel = LateChannel;
  });
  await openSessions(page, CANVAS);
  const other = await context.newPage();
  await openSessions(other, CANVAS);
  expect(await shownElements(page)).toBe(0);
  await drawRectangle(other, { x: 0.3, y: 0.4 });
  await expect.poll(async () => (await files.scene(other, PATHS.empty))?.ids.length ?? 0, { timeout: 5_000 }).toBe(1);
  await drawRectangle(page, { x: 0.7, y: 0.4 });
  const bar = page.locator('.ws-conflict');
  await expect(bar.getByRole('button', { name: 'Reload' })).toBeVisible({ timeout: 5_000 });
  await bar.getByRole('button', { name: 'Reload' }).click();
  await expect(bar).toHaveCount(0);
  expect(await shownElements(page)).toBe(1);
  await page.waitForTimeout(1_000);
  expect((await files.scene(page, PATHS.empty))!.ids).toHaveLength(1);
});
