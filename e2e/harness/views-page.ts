/** Lane C's Playwright helpers for the views harness (e2e/harness/views.html). */
import type { Page } from '@playwright/test';

/** What the harness page exposes on window (see views-harness.tsx). */
export type ViewsHarness = {
  open(path: string): void;
  peek(path: string): string | undefined;
  read(path: string): Promise<string>;
  writeElsewhere(path: string, text: string): Promise<void>;
  sceneElements(path: string): Promise<Array<{ id: string; type: string; isDeleted?: boolean }>>;
  store: { writes: Array<{ path: string; data: unknown }> };
};

type HarnessWindow = Window & { __views?: ViewsHarness; __viewsReady?: boolean };

/** Opens the harness on one file; returns the page errors seen from now on. */
export async function openHarness(page: Page, path: string, query = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/e2e/harness/views.html?file=${encodeURIComponent(path)}${query}`);
  await page.waitForFunction(() => (window as HarnessWindow).__viewsReady === true);
  return errors;
}

/** Opens another file in the same page (the store keeps its contents). */
export async function openFile(page: Page, path: string): Promise<void> {
  await page.evaluate((next) => (window as HarnessWindow).__views!.open(next), path);
  await page.locator(`.ws-stage[data-path="${path.replace(/"/g, '\\"')}"]`).waitFor();
}

export function peek(page: Page, path: string): Promise<string | undefined> {
  return page.evaluate((target) => (window as HarnessWindow).__views!.peek(target), path);
}

export function writesTo(page: Page, path: string): Promise<number> {
  return page.evaluate((target) => (window as HarnessWindow).__views!.store.writes.filter((write) => write.path === target).length, path);
}

export function writeElsewhere(page: Page, path: string, text: string): Promise<void> {
  return page.evaluate(([target, value]) => (window as HarnessWindow).__views!.writeElsewhere(target, value), [path, text] as const);
}

export function sceneElements(page: Page, path: string): Promise<Array<{ id: string; type: string; isDeleted?: boolean }>> {
  return page.evaluate((target) => (window as HarnessWindow).__views!.sceneElements(target), path);
}
