/**
 * How Nebula starts:
 *
 * 1. Open the browser tier (OPFS, or memory when this browser keeps nothing).
 * 2. A brand-new visitor (no projects, never set up) gets the Night Sky
 *    sample and the welcome. Everyone else opens their last project.
 *
 * `nebula:setup` records that this browser has been set up, so removing every
 * project later shows the empty state rather than a new sample. When nothing
 * will be kept, the sample is made in memory, so a visitor can still look
 * around.
 *
 * Where the host offers only its server (the Suite), nothing is made and
 * nothing noted here: a person with no projects there gets the welcome, which
 * offers to start one on the server.
 */
import type { BrowserRegistryHandle } from '../files/opfsRegistry';
import type { BrowserRegistry } from '../files/registry';
import type { SampleResult } from '../files/sample';

/** When this browser was first set up (ISO 8601). */
export const SETUP_KEY = 'nebula:setup';
const BOOT_LOCK = 'nebula:boot';

export type Intro = 'welcome' | null;

export type BootDeps = {
  /** localStorage, or null when the browser blocks it. */
  storage: Storage | null;
  openRegistry: () => Promise<BrowserRegistryHandle>;
  /** seedSampleProject, loaded on demand. */
  seed: (registry: BrowserRegistry) => Promise<SampleResult>;
  now?: () => Date;
};

export type Boot = {
  registry: BrowserRegistry;
  /** False when nothing will be kept. */
  persistent: boolean;
  /** Why nothing will be kept. */
  reason?: string;
  intro: Intro;
};

function read(storage: Storage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: Storage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // A full or blocked storage: the flag is lost, nothing else.
  }
}

// Tabs opening at once must not both make a sample. Web Locks reach across
// tabs; without them (old browsers, tests) a queue in this page does.
let localQueue: Promise<unknown> = Promise.resolve();

function exclusively<T>(action: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks) return locks.request(BOOT_LOCK, action) as Promise<T>;
  const result = localQueue.then(action, action);
  localQueue = result.catch(() => {});
  return result;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export async function bootNebula(deps: BootDeps): Promise<Boot> {
  const { storage } = deps;
  const now = deps.now ?? (() => new Date());
  const { registry, persistent, reason, onlyServer } = await deps.openRegistry();
  if (onlyServer) return { registry, persistent, intro: (await registry.list()).length ? null : 'welcome' };

  return exclusively(async () => {
    const boot: Boot = { registry, persistent, intro: null };
    if (reason) boot.reason = reason;
    const setUp = read(storage, SETUP_KEY) !== null;

    if (!persistent) {
      // Nothing will be kept: the sample lives in this tab.
      try {
        await deps.seed(registry);
        if (!setUp) boot.intro = 'welcome';
      } catch (error) {
        console.error('Nebula could not make the sample project', error);
      }
      return boot;
    }

    const projects = await registry.list();
    if (projects.length > 0 || setUp) {
      if (!setUp) write(storage, SETUP_KEY, now().toISOString());
      return boot;
    }

    try {
      await deps.seed(registry);
      write(storage, SETUP_KEY, now().toISOString());
      boot.intro = 'welcome';
    } catch (error) {
      console.error('Nebula could not make the sample project', describe(error));
    }
    return boot;
  });
}
