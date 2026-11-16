import { act, useEffect, useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileViewProps } from '../files/types';
import { createFakeRegistry, type FakeRegistry } from './dev/fakeRegistry';
import { useProjectLinks } from './views/shared/projectLinks';
import { render, waitFor, type Rendered } from './views/testing/render';
import { Workspace } from './Workspace';

// What a note's links do in the workspace (reading lane, task 1): a link to a
// heading opens its file and scrolls there, also when the file is already
// open and when it has to load first; a link to nothing makes the note.

/** A view that draws its headings a moment after it opens, as a note that has to load does. */
function Probe({ entry }: FileViewProps) {
  const links = useProjectLinks();
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setDrawn(true), 40);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div>
      <p data-testid="open">{entry.path}</p>
      {drawn ? (
        <>
          <h2>Targets</h2>
          <h2>Stars</h2>
          <section className="ws-embed-note">
            <h2>Rigel</h2>
          </section>
          <h2>Rigel</h2>
        </>
      ) : null}
      <button type="button" onClick={() => links.open('Guides/Orion.md', 'stars')}>
        stars
      </button>
      <button type="button" onClick={() => links.open('Guides/Orion.md', 'Rigel')}>
        rigel
      </button>
      <button type="button" onClick={() => links.open('Guides/Orion.md', 'No such heading')}>
        nowhere
      </button>
      <button type="button" onClick={() => links.open('Guides/Moon phases.md')}>
        moon
      </button>
      <button type="button" onClick={() => links.create('Moon rises', 'Guides/Orion.md')}>
        make
      </button>
      <button type="button" onClick={() => links.create('What: now?', 'Guides/Orion.md')}>
        refused
      </button>
      <button type="button" onClick={() => links.create('Observing plan', 'Guides/Orion.md')}>
        existing
      </button>
    </div>
  );
}

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  });
});

let rendered: Rendered | null = null;
let scrolled: HTMLElement[] = [];
let registry: FakeRegistry;

beforeEach(() => {
  scrolled = [];
  Element.prototype.scrollIntoView = vi.fn(function scroll(this: HTMLElement) {
    scrolled.push(this);
  });
  registry = createFakeRegistry({ projects: 1 });
});

afterEach(async () => {
  await rendered?.unmount();
  rendered = null;
  localStorage.clear();
});

async function start() {
  rendered = await render(<Workspace registry={registry} persistent viewFor={() => Probe} downloadProject={async () => {}} />);
  await waitFor(() => expect(rendered!.container.querySelector('[data-testid="open"]')).not.toBeNull());
  return rendered.container;
}

const press = async (container: HTMLElement, name: string) => {
  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === name)?.click();
  });
};

describe('a link to a heading', () => {
  it('opens the file, waits for its view to draw the heading, and scrolls to it', async () => {
    const container = await start();
    expect(container.querySelector('[data-testid="open"]')?.textContent).toBe('Guides/Observing plan.md');
    await press(container, 'stars');
    await waitFor(() => expect(container.querySelector('[data-testid="open"]')?.textContent).toBe('Guides/Orion.md'));
    await waitFor(() => expect(scrolled.map((element) => element.textContent)).toEqual(['Stars']));
    expect(document.activeElement).toBe(scrolled[0]);
  });

  it('scrolls again when the file is already open, once per click', async () => {
    const container = await start();
    await press(container, 'stars');
    await waitFor(() => expect(scrolled).toHaveLength(1));
    await press(container, 'stars');
    await waitFor(() => expect(scrolled).toHaveLength(2));
  });

  it('passes over a heading inside an embedded note: the page’s own is the one', async () => {
    const container = await start();
    await press(container, 'rigel');
    await waitFor(() => expect(scrolled).toHaveLength(1));
    expect(scrolled[0].closest('.ws-embed-note')).toBeNull();
  });

  it('only opens the file when it has no such heading', async () => {
    const container = await start();
    await press(container, 'nowhere');
    await waitFor(() => expect(container.querySelector('[data-testid="open"]')?.textContent).toBe('Guides/Orion.md'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(scrolled).toEqual([]);
  });

  it('does not scroll when the file is opened without a heading, nor when its tab is gone back to later', async () => {
    const container = await start();
    await press(container, 'stars');
    await waitFor(() => expect(scrolled).toHaveLength(1));
    await press(container, 'moon');
    await waitFor(() => expect(container.querySelector('[data-testid="open"]')?.textContent).toBe('Guides/Moon phases.md'));
    await act(async () => {
      [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent?.trim() === 'Orion')?.click();
    });
    await waitFor(() => expect(container.querySelector('[data-testid="open"]')?.textContent).toBe('Guides/Orion.md'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(scrolled).toHaveLength(1);
  });
});

describe('a link to a note that isn’t there', () => {
  it('makes an empty note beside the one holding the link, and opens it', async () => {
    const container = await start();
    const store = registry.stores.get('night-sky')!;
    await press(container, 'make');
    await waitFor(() => expect(container.querySelector('[data-testid="open"]')?.textContent).toBe('Guides/Moon rises.md'));
    expect(await store.readText('Guides/Moon rises.md')).toBe('');
  });

  it('says why when the name is refused, and makes nothing', async () => {
    const container = await start();
    const store = registry.stores.get('night-sky')!;
    const before = (await store.list()).length;
    await press(container, 'refused');
    await waitFor(() => expect(container.querySelector('.ws-status-text')?.textContent).toContain('Windows'));
    expect((await store.list()).length).toBe(before);
    expect(container.querySelector('[data-testid="open"]')?.textContent).toBe('Guides/Observing plan.md');
  });

  it('never writes over a file that is there: it opens it as it is', async () => {
    const container = await start();
    const store = registry.stores.get('night-sky')!;
    const before = await store.readText('Guides/Observing plan.md');
    await press(container, 'existing');
    await waitFor(() => expect(container.querySelector('[data-testid="open"]')?.textContent).toBe('Guides/Observing plan.md'));
    expect(await store.readText('Guides/Observing plan.md')).toBe(before);
  });
});
