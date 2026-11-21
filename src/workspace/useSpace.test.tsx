/**
 * The space Settings shows (src/workspace/useSpace.ts): asked of the store each time Settings
 * opens, nothing from one project shown for another, and nothing where the place sends none.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpaceInfo } from '../files/serverContract';
import { useSpace } from './useSpace';
import { render, settle, waitFor, type Rendered } from './views/testing/render';

let rendered: Rendered | null = null;
afterEach(async () => {
  await rendered?.unmount();
  rendered = null;
});

function Probe({ store, open, into }: { store: unknown; open: boolean; into: { space?: SpaceInfo | null } }) {
  into.space = useSpace(store, open);
  return null;
}

async function probe(store: unknown, open: boolean) {
  const into: { space?: SpaceInfo | null } = {};
  rendered = await render(<Probe store={store} open={open} into={into} />);
  return { into, again: (next: { store?: unknown; open?: boolean }) => rendered!.rerender(<Probe store={'store' in next ? next.store : store} open={next.open ?? open} into={into} />) };
}

const withSpace = (answer: () => Promise<SpaceInfo | undefined>) => ({ space: vi.fn(answer) });

describe('useSpace', () => {
  it('asks nothing while Settings is shut, and asks once when it opens', async () => {
    const store = withSpace(async () => ({ used: 120, limit: 1000 }));
    const hook = await probe(store, false);
    await settle(10);
    expect(store.space).not.toHaveBeenCalled();
    expect(hook.into.space).toBeNull();
    await hook.again({ open: true });
    await waitFor(() => expect(hook.into.space).toEqual({ used: 120, limit: 1000 }));
    expect(store.space).toHaveBeenCalledTimes(1);
  });

  it('asks afresh each time Settings opens', async () => {
    let used = 100;
    const store = withSpace(async () => ({ used }));
    const hook = await probe(store, true);
    await waitFor(() => expect(hook.into.space).toEqual({ used: 100 }));
    await hook.again({ open: false });
    used = 250;
    await hook.again({ open: true });
    await waitFor(() => expect(hook.into.space).toEqual({ used: 250 }));
    expect(store.space).toHaveBeenCalledTimes(2);
  });

  it('is null where the store has no account or the place sends no space', async () => {
    const plain = await probe({ list: async () => [] }, true);
    await settle(10);
    expect(plain.into.space).toBeNull();
    await rendered!.unmount();
    const none = await probe(withSpace(async () => undefined), true);
    await settle(10);
    expect(none.into.space).toBeNull();
    await rendered!.unmount();
    const nobody = await probe(null, true);
    await settle(10);
    expect(nobody.into.space).toBeNull();
  });

  it('shows nothing stale for another project, and never an answer that was for the one before', async () => {
    let answerA!: (space: SpaceInfo) => void;
    const slowA = withSpace(() => new Promise<SpaceInfo>((resolve) => (answerA = resolve)));
    const hook = await probe(slowA, true);
    const quickB = withSpace(async () => ({ used: 5 }));
    await hook.again({ store: quickB });
    await waitFor(() => expect(hook.into.space).toEqual({ used: 5 }));
    answerA({ used: 999 }); // A answers late: it's for a project that isn't open
    await settle(20);
    expect(hook.into.space).toEqual({ used: 5 });

    const never = withSpace(() => new Promise<SpaceInfo>(() => {}));
    await hook.again({ store: never });
    await waitFor(() => expect(hook.into.space).toBeNull());
  });

  it('shows no space when the place can’t be asked', async () => {
    const store = withSpace(async () => {
      throw new Error('down');
    });
    const hook = await probe(store, true);
    await settle(10);
    expect(store.space).toHaveBeenCalledTimes(1);
    expect(hook.into.space).toBeNull();
  });
});
