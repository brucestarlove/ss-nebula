import { describe, expect, it, vi } from 'vitest';
import type { BrowserRegistry } from '../files/registry';

// The older-tab offer (re-review R6) looks for 1.x canvases on every visit.
// Where Nebula 1.x never ran, it must find none without loading the
// migration's code, which stays out of a new visitor's load (the budget,
// e2e/app-budget.spec.ts).
const { newerLegacyCanvases } = vi.hoisted(() => ({ newerLegacyCanvases: vi.fn(async () => []) }));
vi.mock('../files/migration', () => ({ newerLegacyCanvases }));

import { findOlderTabCanvases } from './legacyCanvases';

function storageWith(items: Record<string, string>): Storage {
  const map = new Map(Object.entries(items));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

const registry = {} as BrowserRegistry;

describe('findOlderTabCanvases where Nebula 1.x never ran', () => {
  it('finds none, and loads nothing of the migration', async () => {
    newerLegacyCanvases.mockClear();
    expect(await findOlderTabCanvases(storageWith({ 'nebula:theme': 'dark', 'nebula:bg-dark': 'image' }), registry)).toEqual([]);
    expect(await findOlderTabCanvases(null, registry)).toEqual([]);
    expect(newerLegacyCanvases).not.toHaveBeenCalled();
  });

  it('asks the migration once there is a 1.x canvas in this browser', async () => {
    newerLegacyCanvases.mockClear();
    await findOlderTabCanvases(storageWith({ 'nebula:excalidraw:ss-nebula:plan': '{}' }), registry);
    expect(newerLegacyCanvases).toHaveBeenCalledTimes(1);
  });
});
