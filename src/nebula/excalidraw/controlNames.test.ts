import { afterEach, describe, expect, it } from 'vitest';
import { nameExcalidrawControls } from './controlNames';

// Two of Excalidraw 0.18's own controls fail axe: the main menu's trigger
// has no accessible name (button-name, critical), and the zoom reset is named
// "Reset zoom" while it shows "100%" (label-content-name-mismatch, serious).

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function canvas(): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = `
    <div class="excalidraw">
      <button type="button" class="dropdown-menu-button main-menu-trigger" data-testid="main-menu-trigger"><svg aria-hidden="true"></svg></button>
      <button type="button" class="reset-zoom-button zoom-button" title="Reset zoom" aria-label="Reset zoom">100%</button>
    </div>`;
  document.body.append(root);
  return root;
}

describe('nameExcalidrawControls', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    document.body.innerHTML = '';
  });

  it('names the main menu’s trigger, and the zoom reset with the zoom it shows', () => {
    const root = canvas();
    cleanups.push(nameExcalidrawControls(root));
    expect(root.querySelector('.main-menu-trigger')?.getAttribute('aria-label')).toBe('Canvas menu');
    expect(root.querySelector('.reset-zoom-button')?.getAttribute('aria-label')).toBe('Reset zoom, 100%');
  });

  it('follows the zoom as it changes', async () => {
    const root = canvas();
    cleanups.push(nameExcalidrawControls(root));
    root.querySelector('.reset-zoom-button')!.textContent = '135%';
    await tick();
    expect(root.querySelector('.reset-zoom-button')?.getAttribute('aria-label')).toBe('Reset zoom, 135%');
  });

  it('names controls Excalidraw draws later', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    cleanups.push(nameExcalidrawControls(root));
    root.innerHTML = '<button class="main-menu-trigger"></button><button class="reset-zoom-button" aria-label="Reset zoom">80%</button>';
    await tick();
    expect(root.querySelector('.main-menu-trigger')?.getAttribute('aria-label')).toBe('Canvas menu');
    expect(root.querySelector('.reset-zoom-button')?.getAttribute('aria-label')).toBe('Reset zoom, 80%');
  });

  it('keeps a name Excalidraw gives the trigger itself, and stops when cleaned up', async () => {
    const root = canvas();
    root.querySelector('.main-menu-trigger')!.setAttribute('aria-label', 'Menu');
    const cleanup = nameExcalidrawControls(root);
    expect(root.querySelector('.main-menu-trigger')?.getAttribute('aria-label')).toBe('Menu');
    cleanup();
    root.querySelector('.reset-zoom-button')!.textContent = '50%';
    await tick();
    expect(root.querySelector('.reset-zoom-button')?.getAttribute('aria-label')).toBe('Reset zoom, 100%');
  });
});
