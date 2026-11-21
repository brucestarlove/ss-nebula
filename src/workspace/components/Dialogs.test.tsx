import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from '../views/testing/render';
import { ConfirmDialog, type ConfirmList } from './Dialogs';

// The delete dialog's “Referenced by” list: one item per file, then how many more, and nothing at all
// when nothing refers to the file. Behaviour only: how many items show and which controls act.

beforeAll(() => {
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
});

const item = (n: number, extra: Partial<ConfirmList['items'][number]> = {}) => ({ key: `Notes/n${n}.md`, name: `n${n}`, where: 'Notes', ...extra });

async function show(list: ConfirmList | undefined, handlers: { onConfirm?: () => void; onCancel?: () => void } = {}) {
  rendered = await render(<ConfirmDialog open title="Delete it?" body="Sure." list={list} confirmLabel="Delete" danger onConfirm={handlers.onConfirm ?? (() => {})} onCancel={handlers.onCancel ?? (() => {})} />);
  return rendered.container;
}

const items = (root: ParentNode) => [...root.querySelectorAll('.ws-confirm-list li')];
const more = (root: ParentNode) => root.querySelector('.ws-confirm-list-more');

describe('ConfirmDialog’s list', () => {
  it('shows one item for each reference, and no “more” when there are none beyond', async () => {
    const root = await show({ heading: 'Referenced by', items: [item(1), item(2, { kind: 'canvas' }), item(3)], more: 0 });
    expect(items(root)).toHaveLength(3);
    expect(more(root)).toBeNull();
    // The list is a labelled region of its own: a screen reader can find it by its heading.
    expect(root.querySelector('section.ws-confirm-list')?.getAttribute('aria-labelledby')).toBe(root.querySelector('.ws-confirm-list h3')?.id);
  });

  it('says how many more there are past the ones shown, without listing them', async () => {
    const root = await show({ heading: 'Referenced by', items: [1, 2, 3, 4, 5].map((n) => item(n)), more: 2 });
    expect(items(root)).toHaveLength(5);
    expect(more(root)).not.toBeNull();
    expect(more(root)?.textContent).toContain('2');
  });

  it('shows no list at all when there is none, or it is empty', async () => {
    let root = await show(undefined);
    expect(root.querySelector('.ws-confirm-list')).toBeNull();
    await rendered?.unmount();
    root = await show({ heading: 'Referenced by', items: [], more: 0 });
    expect(root.querySelector('.ws-confirm-list')).toBeNull();
  });

  it('keeps Delete and Cancel working with a list under the paragraph', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const root = await show({ heading: 'Referenced by', items: [item(1)], more: 0 }, { onConfirm, onCancel });
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('dialog button')];
    expect(buttons).toHaveLength(2);
    const confirm = buttons.find((button) => button.hasAttribute('data-danger'))!;
    await act(async () => confirm.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => buttons.find((button) => button !== confirm)!.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
