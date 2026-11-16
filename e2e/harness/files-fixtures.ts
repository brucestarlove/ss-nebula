// Fixtures shared by the files lane's specs (e2e/files-*.spec.ts).
import { test as base, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.env.NEBULA_E2E_PORT || 4340);
export const baseURL = `http://127.0.0.1:${port}`;

type Fixtures = {
  /** A page of the persistent context on the OPFS harness, ready to drive. */
  harness: Page;
};

type WorkerFixtures = {
  /** WebKit keeps OPFS only in a persistent context, so the OPFS specs use one in both browsers. */
  persistentContext: BrowserContext;
};

export const test = base.extend<Fixtures, WorkerFixtures>({
  persistentContext: [
    async ({ playwright, browserName }, provide) => {
      const dir = mkdtempSync(join(tmpdir(), `nebula-files-${browserName}-`));
      const context = await playwright[browserName].launchPersistentContext(dir, { baseURL });
      try {
        await provide(context);
      } finally {
        await context.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    { scope: 'worker' },
  ],
  harness: async ({ persistentContext }, provide) => {
    const page = await openHarness(persistentContext);
    await provide(page);
    await page.close();
  },
});

export async function openHarness(context: BrowserContext, path = '/e2e/harness/files-opfs.html'): Promise<Page> {
  const page = await context.newPage();
  await page.goto(path);
  await page.waitForFunction(() => (window as unknown as { filesHarnessReady?: boolean }).filesHarnessReady === true);
  return page;
}

export { expect } from '@playwright/test';
