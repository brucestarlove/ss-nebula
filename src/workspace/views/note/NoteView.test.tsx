import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFileStore, type MemoryFileStore } from '../../../../e2e/harness/views-store';
import type { FileEntry } from '../../../files/types';
import { byLabel, click, render, settle, waitFor } from '../testing/render';
import NoteView from './NoteView';

const PATH = 'Guides/Observing plan.md';
const entry: FileEntry = { path: PATH, name: 'Observing plan.md', type: 'file', size: 100, modified: Date.now() - 4 * 60_000 };

const SOURCE = [
  '---',
  'tags: [stargazing]',
  'title: Not the title',
  '---',
  'Saturday, after moonset. #october',
  '',
  '## Targets',
  '',
  '- [x] Orion Nebula (M42). Notes in [[Orion]].',
  '- [ ] The Pleiades (M45).',
  '  - [ ] Binoculars first',
  '* [ ] Andromeda (M31)',
  '',
  '1. [ ] Count meteors',
  '',
  '> - [ ] A quoted task',
  '',
  'See [the chart](https://example.com/chart) and [[Star chart|the October chart]].',
  '',
  '<img src="x" onerror="window.__pwned = true">',
  '',
].join('\n');

function lines(text: string | undefined): string[] {
  return (text ?? '').split('\n');
}

describe('NoteView', () => {
  let store: MemoryFileStore;

  beforeEach(() => {
    store = createMemoryFileStore({ [PATH]: SOURCE });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  async function open(props: Partial<Parameters<typeof NoteView>[0]> = {}) {
    const view = await render(<NoteView projectId="p" store={store} entry={entry} kind="note" {...props} />);
    await waitFor(() => expect(view.container.querySelector('.ws-prose')).not.toBeNull());
    return view;
  }

  it('shows a note that isn’t UTF-8 read-only: no editing, no task boxes, and Download', async () => {
    // A task list with a Latin-1 'é'.
    const bytes = new Uint8Array([...new TextEncoder().encode('- [ ] Caf'), 0xe9, 0x0a]);
    store = createMemoryFileStore({ [PATH]: new Blob([bytes]) });
    const view = await open();
    expect(view.container.querySelector('[aria-label="Edit"]')).toBeNull();
    expect(view.container.querySelector<HTMLInputElement>('.ws-prose input[type="checkbox"]')?.disabled).toBe(true);
    const bar = view.container.querySelector('.ws-conflict');
    expect(bar?.textContent).toContain('isn’t UTF-8');
    expect(bar?.querySelector('button')?.textContent?.trim()).toBe('Download');
    await view.unmount();
    expect(store.writes).toHaveLength(0);
  });

  describe('images from the web', () => {
    const WEB = ['Before ![Tracker](https://tracker.example/p.png?u=1) after.', '', '![Second][chart]', '', '[chart]: https://charts.example/sky.png', ''].join('\n');

    function remoteImages(container: HTMLElement): string[] {
      return [...container.querySelectorAll<HTMLImageElement>('.ws-prose img')].map((image) => image.getAttribute('src') ?? '');
    }

    it('wait for a click, so a note can’t carry a tracking pixel', async () => {
      store = createMemoryFileStore({ [PATH]: WEB });
      const view = await open({ projectId: 'web-1' });
      expect(remoteImages(view.container)).toEqual([]);
      const placeholders = [...view.container.querySelectorAll('.ws-remote-image')].map((item) => item.textContent);
      expect(placeholders).toEqual(['Tracker · tracker.example', 'Second · charts.example']);
      const load = byLabel(view.container, 'Load images');
      expect(load).not.toBeNull();
      await click(load);
      expect(remoteImages(view.container)).toEqual(['https://tracker.example/p.png?u=1', 'https://charts.example/sky.png']);
      expect(view.container.querySelector('.ws-prose img')?.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(byLabel(view.container, 'Load images')).toBeNull();
      await view.unmount();
    });

    it('stay loaded for that note while the page is open, and only that note', async () => {
      store = createMemoryFileStore({ [PATH]: WEB, 'Other.md': WEB });
      const first = await open({ projectId: 'web-2' });
      await click(byLabel(first.container, 'Load images'));
      await first.unmount();
      const again = await open({ projectId: 'web-2' });
      expect(remoteImages(again.container)).toHaveLength(2);
      await again.unmount();
      const other = await open({ projectId: 'web-2', entry: { ...entry, path: 'Other.md', name: 'Other.md' } });
      expect(remoteImages(other.container)).toEqual([]);
      await other.unmount();
    });

    it('leave a note without web images as it was', async () => {
      store = createMemoryFileStore({ [PATH]: 'Just text, and ![a photo](Photos/a.jpg) from the project.' });
      const view = await open();
      expect(byLabel(view.container, 'Load images')).toBeNull();
      expect(view.container.querySelector('.ws-embed-pending')?.textContent).toBe('a photo');
      await view.unmount();
    });
  });

  it('reads like the sketch: the file name as title, the folder, the tags, no frontmatter', async () => {
    const view = await open();
    const page = view.container.querySelector('.ws-page');
    expect(page?.querySelector('h1')?.textContent).toBe('Observing plan');
    const meta = page?.querySelector('.ws-meta');
    expect(meta?.textContent).toContain('Guides');
    expect(meta?.textContent).toContain('Edited 4 min ago');
    expect([...(meta?.querySelectorAll('.ws-tag') ?? [])].map((tag) => tag.textContent)).toEqual(['#stargazing', '#october']);
    expect(page?.textContent).not.toContain('Not the title');
    expect(page?.querySelector('.ws-prose h2')?.textContent).toBe('Targets');
    expect(page?.querySelector('.ws-prose hr')).toBeNull();
    await view.unmount();
  });

  it('writes a task toggle back to its own source line, and nowhere else', async () => {
    const view = await open();
    const boxes = [...view.container.querySelectorAll<HTMLInputElement>('.ws-prose input[type="checkbox"]')];
    expect(boxes).toHaveLength(6);
    expect(boxes.map((box) => box.checked)).toEqual([true, false, false, false, false, false]);

    const expected = (lineIndex: number, from: string, to: string) => {
      const next = lines(SOURCE);
      next[lineIndex] = next[lineIndex].replace(from, to);
      return next.join('\n');
    };

    await click(boxes[1]);
    await waitFor(() => expect(store.peek(PATH)).toBe(expected(9, '[ ]', '[x]')));

    await click(view.container.querySelectorAll('.ws-prose input[type="checkbox"]')[2]);
    await waitFor(() => expect(lines(store.peek(PATH))[10]).toBe('  - [x] Binoculars first'));

    await click(view.container.querySelectorAll('.ws-prose input[type="checkbox"]')[0]);
    await waitFor(() => expect(lines(store.peek(PATH))[8]).toBe('- [ ] Orion Nebula (M42). Notes in [[Orion]].'));

    for (const [index, line] of [
      [3, 11],
      [4, 13],
      [5, 15],
    ]) {
      await click(view.container.querySelectorAll('.ws-prose input[type="checkbox"]')[index]);
      await waitFor(() => expect(lines(store.peek(PATH))[line]).toContain('[x]'));
    }
    const final = lines(store.peek(PATH));
    expect(final.filter((line, index) => line !== lines(SOURCE)[index])).toHaveLength(6);
    expect(view.container.querySelectorAll('.ws-prose input[type="checkbox"]:checked')).toHaveLength(5);
    await view.unmount();
  });

  it('opens web links in a new tab, shows wikilinks as plain text, and never renders raw HTML', async () => {
    const view = await open();
    const prose = view.container.querySelector('.ws-prose');
    const link = prose?.querySelector<HTMLAnchorElement>('a[href="https://example.com/chart"]');
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toBe('noopener noreferrer');
    expect(prose?.textContent).toContain('Notes in Orion.');
    expect(prose?.textContent).toContain('and the October chart.');
    expect(prose?.textContent).not.toContain('[[');
    expect(prose?.querySelector('img')).toBeNull();
    expect((window as { __pwned?: boolean }).__pwned).toBeUndefined();
    await view.unmount();
  });

  it('reports its word count and that nothing is unsaved', async () => {
    const onStatus = vi.fn();
    const onDirty = vi.fn();
    const view = await open({ onStatus, onDirty });
    await waitFor(() => expect(onStatus).toHaveBeenLastCalledWith('35 words'));
    expect(onDirty).toHaveBeenLastCalledWith(false);
    await view.unmount();
  });

  it('reloads when the file changes elsewhere and nothing is unsaved', async () => {
    const view = await open();
    await store.write(PATH, '# Rewritten\n\nBy an agent.');
    await waitFor(() => expect(view.container.querySelector('.ws-prose')?.textContent).toContain('By an agent.'));
    await view.unmount();
  });

  it('falls back to the info card when the note cannot be read', async () => {
    store.unreadable.add(PATH);
    const view = await render(<NoteView projectId="p" store={store} entry={entry} kind="note" />);
    await waitFor(() => expect(view.container.querySelector('.ws-info-card')).not.toBeNull());
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(PATH);
    await settle();
    await view.unmount();
  });

  describe('a first heading that repeats the file name', () => {
    const TITLED = ['---', 'tags: [stargazing]', '---', '', '# Observing plan', '', 'Saturday, after moonset.', '', '- [ ] The Pleiades (M45).', ''].join('\n');

    function headings(container: HTMLElement): string[] {
      return [...container.querySelectorAll('.ws-page h1, .ws-page h2')].map((heading) => `${heading.tagName}:${heading.textContent}`);
    }

    it('shows the title once', async () => {
      store = createMemoryFileStore({ [PATH]: TITLED });
      const view = await open();
      expect(headings(view.container)).toEqual(['H1:Observing plan']);
      expect(view.container.querySelector('.ws-prose')?.textContent).toContain('Saturday, after moonset.');
      await view.unmount();
    });

    it('matches the name whatever its case', async () => {
      store = createMemoryFileStore({ [PATH]: '# OBSERVING Plan\n\nSaturday.\n' });
      const view = await open();
      expect(headings(view.container)).toEqual(['H1:Observing plan']);
      await view.unmount();
    });

    it('keeps a first heading that says something else', async () => {
      store = createMemoryFileStore({ [PATH]: '# Night Sky\n\nA sample project.\n' });
      const view = await open();
      expect(headings(view.container)).toEqual(['H1:Observing plan', 'H1:Night Sky']);
      await view.unmount();
    });

    it('keeps the name as a heading further down', async () => {
      store = createMemoryFileStore({ [PATH]: 'Saturday.\n\n# Observing plan\n\nAgain.\n' });
      const view = await open();
      expect(headings(view.container)).toEqual(['H1:Observing plan', 'H1:Observing plan']);
      await view.unmount();
    });

    it('still writes a task back to its own line', async () => {
      store = createMemoryFileStore({ [PATH]: TITLED });
      const view = await open();
      await click(view.container.querySelector('.ws-prose input[type="checkbox"]'));
      await waitFor(() => expect(lines(store.peek(PATH))[8]).toBe('- [x] The Pleiades (M45).'));
      expect(lines(store.peek(PATH))[4]).toBe('# Observing plan');
      await view.unmount();
    });
  });
});
