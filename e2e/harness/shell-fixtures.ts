import type { Page } from '@playwright/test';

/** Opens the shell harness (e2e/harness/shell.html) over the in-memory
 * registry. `storage` seeds localStorage once (theme, preferences). */
export async function openShell(page: Page, query = '', storage: Record<string, string> = {}) {
  await page.addInitScript((seed) => {
    if (sessionStorage.getItem('shell-seeded')) return;
    sessionStorage.setItem('shell-seeded', '1');
    for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
  }, { 'nebula:theme': 'dark', ...storage });
  await page.goto(`/e2e/harness/shell.html${query ? `?${query}` : ''}`);
  await page.locator('.ws-root').waitFor();
}

/** Waits until the project's files are listed (on a phone the rail is
 * off screen until opened, so this waits for them to exist, not show). */
export async function filesReady(page: Page) {
  await page.locator('.ws-filetree [role="treeitem"]').first().waitFor({ state: 'attached' });
}

/** A tree row by path. */
export function row(page: Page, path: string) {
  return page.locator(`.ws-filetree [role="treeitem"][data-path="${path}"]`);
}

/** Reads a file from a project's in-memory store. */
export async function readFile(page: Page, project: string, path: string): Promise<string | null> {
  return page.evaluate(
    async ({ project, path }) => {
      const store = window.__shell.registry.stores.get(project);
      if (!store) return null;
      try {
        return await store.readText(path);
      } catch {
        return null;
      }
    },
    { project, path },
  );
}

export async function listPaths(page: Page, project: string): Promise<string[]> {
  return page.evaluate(async (project) => {
    const store = window.__shell.registry.stores.get(project);
    return store ? (await store.list()).map((entry) => entry.path) : [];
  }, project);
}

declare global {
  interface Window {
    __shell: {
      registry: {
        stores: Map<
          string,
          {
            readText(path: string): Promise<string>;
            write(path: string, data: string | Blob): Promise<void>;
            remove(path: string): Promise<void>;
            rename(from: string, to: string): Promise<void>;
            list(): Promise<{ path: string; name: string; type: string }[]>;
          }
        >;
      };
      downloads: string[];
      introDone: number;
      help: number;
    };
  }
}
