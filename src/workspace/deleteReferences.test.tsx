import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FileViewProps } from '../files/types';
import { createFakeRegistry } from './dev/fakeRegistry';
import { render, settle, type Rendered } from './views/testing/render';
import { Workspace } from './Workspace';

// Deleting a file other files refer to lists them first: the workspace asks the project index and hands the
// dialog its “Referenced by” list. The sample project's Observing plan is linked from Orion and the README (and the real sample's Moon phases).

function Probe({ entry }: FileViewProps) {
  return <p data-testid="probe">{entry.path}</p>;
}

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  });
  const proto = HTMLDialogElement.prototype as { showModal?: () => void; close?: () => void };
  proto.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

let rendered: Rendered | null = null;
afterEach(async () => {
  await rendered?.unmount();
  rendered = null;
  localStorage.clear();
});

const listed = () => [...document.querySelectorAll('dialog[open] .ws-confirm-list li')];

/** Presses Delete on a tree row, and cancels the dialog (the index may not be ready yet) until it lists something or time runs out. */
async function askToDelete(path: string, expectList: boolean) {
  const row = () => rendered!.container.querySelector<HTMLElement>(`.ws-filetree [role="treeitem"][data-path="${path}"]`)!;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await act(async () => row().focus());
    await act(async () => {
      row().dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    if (document.querySelector('dialog[open]') && (listed().length > 0 || !expectList)) {
      // Not yet ready is told by an empty list: ask again a little later.
      if (listed().length > 0 || attempt >= 30) return;
    }
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('dialog[open] button')].find((button) => button.textContent === 'Cancel');
    if (cancel) await act(async () => cancel.click());
    await settle(100);
  }
}

describe('the delete dialog’s Referenced by list', () => {
  it('lists the notes that link to a note being deleted', async () => {
    const registry = createFakeRegistry();
    rendered = await render(<Workspace registry={registry} persistent viewFor={() => Probe} />);
    await settle(30);
    await askToDelete('Guides/Observing plan.md', true);
    const names = listed().map((item) => item.querySelector('.ws-confirm-list-name')?.textContent);
    expect(names.length).toBeGreaterThan(0);
    // Orion and the README link to it in the sample; the plan itself is never listed.
    expect(names).toEqual(expect.arrayContaining(['Orion', 'README']));
    expect(names).not.toContain('Observing plan');
    expect(names.length).toBeLessThanOrEqual(6);
  });
});
