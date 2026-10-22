import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangeListeners } from './listeners';

describe('ChangeListeners', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps telling the other watchers when one throws, and reports the failure', () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const listeners = new ChangeListeners();
    const heard: string[] = [];
    listeners.add(() => {
      throw new Error('boom');
    });
    listeners.add((change) => heard.push(change.type));

    expect(() => listeners.emit({ type: 'write', path: 'a.md' })).not.toThrow();
    expect(heard).toEqual(['write']);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('lets the same function watch twice and stop once', () => {
    const listeners = new ChangeListeners();
    const heard: string[] = [];
    const listener = (change: { type: string }) => heard.push(change.type);
    const stopFirst = listeners.add(listener);
    listeners.add(listener);
    stopFirst();
    listeners.emit({ type: 'mkdir', path: 'F' });
    expect(heard).toEqual(['mkdir']);
    expect(listeners.size).toBe(1);
  });
});
