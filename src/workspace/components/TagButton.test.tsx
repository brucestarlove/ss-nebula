import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SEARCH_EVENT, type SearchRequest } from '../searchEvent';
import { render, type Rendered } from '../views/testing/render';
import { TagButton } from './TagButton';

// A tag in the reading view or the header is a real button that opens search for it.

const searches: string[] = [];
const listener = (event: Event) => {
  searches.push((event as CustomEvent<SearchRequest>).detail.query);
  event.preventDefault();
};
let rendered: Rendered | null = null;
beforeEach(() => window.addEventListener(SEARCH_EVENT, listener));
afterEach(async () => {
  window.removeEventListener(SEARCH_EVENT, listener);
  searches.length = 0;
  await rendered?.unmount();
  rendered = null;
});

describe('TagButton', () => {
  it('is a button, so Tab reaches it, and a click opens search for the tag, lowercase and with one #', async () => {
    rendered = await render(
      <>
        <TagButton tag="Orion" />
        <TagButton tag="#Project/Nebula" />
      </>,
    );
    const buttons = [...rendered.container.querySelectorAll('button')];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.tabIndex >= 0 && button.disabled === false)).toBe(true);
    await act(async () => buttons[0].click());
    await act(async () => buttons[1].click());
    expect(searches).toEqual(['#orion', '#project/nebula']);
  });

  it('carries the classes the stylesheet makes a link of, and takes a name of its own', async () => {
    rendered = await render(<TagButton tag="orion" className="extra" label="Search for #orion, 3 files" />);
    const button = rendered.container.querySelector('button')!;
    expect(button.classList.contains('ws-tag')).toBe(true);
    expect(button.classList.contains('ws-tag-button')).toBe(true);
    expect(button.classList.contains('extra')).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('Search for #orion, 3 files');
  });
});
