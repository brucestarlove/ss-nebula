/** Test helpers for the views: React 19 rendering without a testing library. */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export type Rendered = {
  container: HTMLElement;
  rerender(ui: ReactNode): Promise<void>;
  unmount(): Promise<void>;
};

export async function render(ui: ReactNode): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(ui);
  });
  return {
    container,
    async rerender(next) {
      await act(async () => {
        root?.render(next);
      });
    },
    async unmount() {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

/** Lets pending promises and React updates settle. */
export async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Retries `assertion` until it passes (about a second in all). An async
 * assertion is awaited: without that, its rejection would escape the retry
 * and the call would return at once, as if it had passed. */
export async function waitFor(assertion: () => void | Promise<void>, attempts = 200): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await settle(5);
    }
  }
  throw lastError;
}

export async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('Nothing to click');
  await act(async () => {
    (element as HTMLElement).click();
  });
}

/** Finds a button (or link) by its accessible text or aria-label. */
export function byLabel(container: ParentNode, label: string): HTMLElement | null {
  const candidates = container.querySelectorAll<HTMLElement>('button, a, [role="button"], input');
  for (const candidate of candidates) {
    const name = candidate.getAttribute('aria-label') ?? candidate.textContent ?? '';
    if (name.trim() === label) return candidate;
  }
  return null;
}
