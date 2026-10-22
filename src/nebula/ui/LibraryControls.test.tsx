import { describe, expect, it, vi } from 'vitest';
import { render } from '../../workspace/views/testing/render';
import { LibraryControls } from './LibraryControls';

// The library helpers import Excalidraw, which jsdom can't load; the controls
// never call it.
vi.mock('@excalidraw/excalidraw', () => ({ loadLibraryFromBlob: vi.fn(), serializeLibraryAsJSON: vi.fn() }));

// WCAG 2.5.3 (axe's label-content-name-mismatch): a control's accessible
// name holds the words it shows, so speech users can say what they see.

const collections = [
  { id: 'personal', name: 'Personal Library', items: [], createdAt: 0 },
  { id: 'stars', name: 'Star shapes', items: [], createdAt: 1 },
];

function props(activeId = 'stars') {
  return {
    collections,
    activeId,
    hasSelection: true,
    onSwitch: vi.fn(),
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onSaveToFile: vi.fn(),
    onPublish: vi.fn(),
    onAddSelectionTo: vi.fn(),
    onNewFromSelection: vi.fn(),
  };
}

/** The words a control shows, without the decorative glyphs it hides. */
function visibleWords(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('LibraryControls', () => {
  it('names each trigger with the words it shows', async () => {
    const view = await render(<LibraryControls {...props()} />);
    const triggers = [...view.container.querySelectorAll('.nebula-library-trigger')];
    expect(triggers).toHaveLength(2);
    for (const trigger of triggers) {
      const name = trigger.getAttribute('aria-label') ?? '';
      expect(name.toLowerCase(), name).toContain(visibleWords(trigger).toLowerCase());
    }
    expect(view.container.querySelector('.nebula-library-trigger--switch')?.getAttribute('aria-label')).toContain('Star shapes');
    await view.unmount();
  });
});
