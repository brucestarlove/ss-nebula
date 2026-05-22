import { beforeEach, describe, expect, it, vi } from 'vitest';

const reactRoot = vi.hoisted(() => ({
  render: vi.fn(),
  unmount: vi.fn(),
}));

const createRoot = vi.hoisted(() => vi.fn(() => reactRoot));

vi.mock('react-dom/client', () => ({
  createRoot,
}));

import type { ReactElement } from 'react';
import { mountNebula, type MountNebulaOptions, type NebulaMountHandle } from './mountNebula';

function lastRenderedProps(): Record<string, unknown> {
  const element = reactRoot.render.mock.calls.at(-1)?.[0] as ReactElement<Record<string, unknown>> | undefined;
  if (!element) throw new Error('Expected Nebula root to render');
  const child = element.props.children as ReactElement<Record<string, unknown>> | undefined;
  if (!child) throw new Error('Expected Nebula error boundary to render a child');
  return child.props;
}

describe('mountNebula public API', () => {
  beforeEach(() => {
    createRoot.mockClear();
    reactRoot.render.mockClear();
    reactRoot.unmount.mockClear();
    delete window.__NEBULA_CONTEXT__;
  });

  it('returns a synchronous handle without touching the standalone entrypoint or window context by default', () => {
    const container = document.createElement('div');
    const handle = mountNebula(container, {
      context: { boardId: 'suite-board', canvasId: 'suite-canvas' },
    });

    expect(handle.container).toBe(container);
    expect(handle.getStatus()).toBe('mounted');
    expect(handle.ready).toBeInstanceOf(Promise);
    expect(createRoot).toHaveBeenCalledWith(container);
    expect(lastRenderedProps()).toMatchObject({
      context: { boardId: 'suite-board', canvasId: 'suite-canvas' },
    });
    expect(window.__NEBULA_CONTEXT__).toBeUndefined();
  });

  it('supports top-level context fields for compatibility while preferring options.context', () => {
    mountNebula(document.createElement('div'), {
      boardId: 'top-level-board',
      canvasId: 'top-level-canvas',
      context: { canvasId: 'nested-canvas' },
    });

    expect(lastRenderedProps()).toMatchObject({
      context: { boardId: 'top-level-board', canvasId: 'nested-canvas' },
    });
  });

  it('injects custom stores, updates options, and exposes window context only when requested', () => {
    const store: MountNebulaOptions['store'] = {
      load: vi.fn(),
      save: vi.fn(),
      list: vi.fn(),
    };
    const handle = mountNebula(document.createElement('div'), {
      context: { boardId: 'initial' },
      store,
      exposeContextOnWindow: true,
    });

    expect(lastRenderedProps().store).toBe(store);
    expect(window.__NEBULA_CONTEXT__).toMatchObject({ boardId: 'initial' });

    handle.update({ context: { boardId: 'updated', canvasId: 'canvas-b' }, store });

    expect(lastRenderedProps()).toMatchObject({
      context: { boardId: 'updated', canvasId: 'canvas-b' },
      store,
    });
    expect(reactRoot.render).toHaveBeenCalledTimes(2);
  });

  it('settles ready via the lazy shell callback and calls lifecycle hooks once', async () => {
    const onReady = vi.fn();
    const onUnmount = vi.fn();
    const handle = mountNebula(document.createElement('div'), { lifecycle: { onReady, onUnmount } });

    const props = lastRenderedProps();
    expect(typeof props.onReady).toBe('function');
    (props.onReady as () => void)();
    (props.onReady as () => void)();

    await expect(handle.ready).resolves.toBeUndefined();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(handle);

    handle.unmount();
    handle.unmount();

    expect(handle.getStatus()).toBe('unmounted');
    expect(reactRoot.unmount).toHaveBeenCalledTimes(1);
    expect(onUnmount).toHaveBeenCalledTimes(1);
  });

  it('rejects ready when unmounted before the lazy shell becomes ready', async () => {
    const onUnmount = vi.fn();
    const handle = mountNebula(document.createElement('div'), { onUnmount });

    handle.unmount();

    await expect(handle.ready).rejects.toThrow(/unmounted before it became ready/);
    expect(onUnmount).toHaveBeenCalledTimes(1);
  });

  it('rejects updates after unmount', () => {
    const handle: NebulaMountHandle = mountNebula(document.createElement('div'));
    handle.unmount();
    void handle.ready.catch(() => undefined);

    expect(() => handle.update({ context: { boardId: 'too-late' } })).toThrow(/unmounted/);
  });
});
