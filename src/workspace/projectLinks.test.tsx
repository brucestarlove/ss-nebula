import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FileViewProps } from '../files/types';
import { createFakeRegistry } from './dev/fakeRegistry';
import { useProjectLinks } from './views/shared/projectLinks';
import { render, settle, waitFor, type Rendered } from './views/testing/render';
import { Workspace } from './Workspace';

// The seam the notes slice builds on: a view can read the project's files and
// open one in a tab.

function Probe({ entry }: FileViewProps) {
  const links = useProjectLinks();
  return (
    <div>
      <p data-testid="open">{entry.path}</p>
      <p data-testid="files">{links.files.map((file) => file.path).join('|')}</p>
      <button type="button" onClick={() => links.open('Guides/Orion.md')}>
        go
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
afterEach(async () => {
  await rendered?.unmount();
  rendered = null;
  localStorage.clear();
});

describe('what a view gets from the workspace', () => {
  it('reads every file of the project, and opens one in a tab', async () => {
    const registry = createFakeRegistry({ projects: 1 });
    rendered = await render(<Workspace registry={registry} persistent viewFor={() => Probe} downloadProject={async () => {}} />);
    await waitFor(() => expect(rendered!.container.querySelector('.ws-filetree')?.textContent).toContain('Orion'));
    await act(async () => {
      [...rendered!.container.querySelectorAll<HTMLElement>('.ws-filetree [role="treeitem"]')].find((row) => row.dataset.path === 'README.md')?.click();
    });
    await waitFor(() => expect(rendered!.container.querySelector('[data-testid="open"]')?.textContent).toBe('README.md'));
    const listed = rendered!.container.querySelector('[data-testid="files"]')!.textContent!.split('|');
    expect(listed).toContain('Guides/Orion.md');
    expect(listed).toContain('README.md');
    expect(listed.every((path) => !path.endsWith('/'))).toBe(true);
    await act(async () => [...rendered!.container.querySelectorAll<HTMLButtonElement>('.ws-stage button')].find((button) => button.textContent === 'go')!.click());
    await settle(5);
    await waitFor(() => expect(rendered!.container.querySelector('[data-testid="open"]')?.textContent).toBe('Guides/Orion.md'));
  });
});
