import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES } from '../../files/types';
import type { BackdropControls } from '../useBackdrop';
import { byLabel, click, render, type Rendered } from '../views/testing/render';
import type { RecentlyDeleted } from '../useRemovedProjects';
import { SettingsDrawer, type SettingsProps } from './Settings';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }),
  });
});

let rendered: Rendered | null = null;
afterEach(async () => {
  await rendered?.unmount();
  rendered = null;
});

function backdrop(patch: Partial<BackdropControls> = {}, value: Partial<BackdropControls['value']> = {}): BackdropControls {
  return {
    side: 'night',
    value: { mode: 'rich', colour: '#000000', fade: 0.3, image: null, thumb: null, ...value },
    imageUrl: null,
    status: 'idle',
    problem: null,
    canUseImages: true,
    setMode: vi.fn(),
    setColour: vi.fn(),
    setFade: vi.fn(),
    chooseImage: vi.fn(async () => {}),
    removeImage: vi.fn(async () => {}),
    ...patch,
  };
}

function props(patch: Partial<SettingsProps> = {}): SettingsProps {
  return {
    open: true,
    tab: 'appearance',
    onTab: vi.fn(),
    onClose: vi.fn(),
    themeMode: 'dark',
    resolvedTheme: 'dark',
    onThemeMode: vi.fn(),
    backdrop: backdrop(),
    motion: false,
    onMotion: vi.fn(),
    preferences: DEFAULT_PREFERENCES,
    onPreference: vi.fn(),
    projectCount: 1,
    project: { id: 'night-sky', name: 'Night Sky', color: '#7c8cff', created: '2026-10-22T00:00:00.000Z', createdBy: 'nebula', tier: 'browser' },
    location: 'In this browser',
    usage: '1 MB',
    fileCount: 13,
    ephemeral: false,
    kept: true,
    canDownload: true,
    onRename: vi.fn(),
    onColour: vi.fn(),
    onDownload: vi.fn(),
    onImport: vi.fn(),
    onRemove: vi.fn(),
    ...patch,
  };
}

function radios(label: string): string[] | null {
  const group = document.querySelector(`[role="radiogroup"][aria-label="${label}"]`);
  return group ? [...group.querySelectorAll('[role="radio"]')].map((radio) => radio.getAttribute('aria-label') ?? radio.textContent ?? '') : null;
}

function drawerText(): string {
  return document.querySelector('.ws-settings')?.textContent ?? '';
}

describe('Settings', () => {
  it('is titled Settings, with nothing over it', async () => {
    rendered = await render(<SettingsDrawer {...props()} />);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent).toBe('Settings');
    expect(dialog.querySelector('.drawer-header')!.textContent).not.toMatch(/nebula/i);
  });

  it('puts Appearance before Project (Bruce, 2026-10-25: back to that order)', async () => {
    rendered = await render(<SettingsDrawer {...props()} />);
    expect([...document.querySelectorAll('.ws-settings [role="tab"]')].map((tab) => tab.textContent)).toEqual(['Appearance', 'Project']);
  });
});

describe('Settings, Appearance: the background', () => {
  it('offers Starfield, Colour and Image at night, with the animation switch under Starfield', async () => {
    rendered = await render(<SettingsDrawer {...props()} />);
    expect(radios('Night background')).toEqual(['Starfield', 'Colour', 'Image']);
    expect(drawerText()).toContain('Animated background');
  });

  it('offers Parchment, Colour and Image by day, with no animation switch', async () => {
    rendered = await render(<SettingsDrawer {...props({ resolvedTheme: 'light', themeMode: 'light', backdrop: backdrop({ side: 'day' }, { colour: '#ffffff' }) })} />);
    expect(radios('Day background')).toEqual(['Parchment', 'Colour', 'Image']);
    expect(drawerText()).not.toContain('Animated background');
  });

  it("shows the theme's six colours under Colour, then any colour at all", async () => {
    const controls = backdrop({}, { mode: 'plain' });
    rendered = await render(<SettingsDrawer {...props({ backdrop: controls })} />);
    expect(radios('Night background colour')).toEqual(['Black', 'Midnight', 'Indigo', 'Plum', 'Pine', 'Graphite']);
    expect(document.querySelector('.ws-settings input[type="color"][aria-label="Any colour"]')).not.toBeNull();
    expect(drawerText()).not.toContain('Animated background');
    await act(async () => document.querySelector<HTMLButtonElement>('.ws-settings [role="radio"][aria-label="Indigo"]')!.click());
    expect(controls.setColour).toHaveBeenCalledWith('#1b1747');
  });

  it('chooses an image from the tile, and says where it is kept', async () => {
    const controls = backdrop({}, { mode: 'image' });
    rendered = await render(<SettingsDrawer {...props({ backdrop: controls })} />);
    expect(document.querySelector('.ws-settings button[aria-label="Choose a background image"]')).not.toBeNull();
    const input = document.querySelector<HTMLInputElement>('.ws-settings input[type="file"]')!;
    expect(input.accept).toBe('image/*');
    const file = new File(['png'], 'carina.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(controls.chooseImage).toHaveBeenCalledWith(file);
    expect(drawerText()).toContain('Kept in this browser, on this device.');
  });

  it('fades and removes the image once there is one', async () => {
    const controls = backdrop({ imageUrl: 'blob:https://nebula.starscape.app/1', status: 'ready' }, { mode: 'image', image: 'night-a1.jpg' });
    rendered = await render(<SettingsDrawer {...props({ backdrop: controls })} />);
    expect(document.querySelector('.ws-settings button[aria-label="Replace the background image"]')).not.toBeNull();
    const slider = document.querySelector<HTMLInputElement>('.ws-settings input[type="range"]')!;
    expect(slider.getAttribute('aria-label')).toBe('Fade');
    expect(slider.value).toBe('30');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(slider, '60');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(controls.setFade).toHaveBeenCalledWith(0.6);
    const remove = [...document.querySelectorAll<HTMLButtonElement>('.ws-settings button')].find((button) => button.textContent?.trim() === 'Remove')!;
    await act(async () => remove.click());
    expect(controls.removeImage).toHaveBeenCalled();
  });

  it('says the image lasts until the tab closes where the browser keeps nothing', async () => {
    rendered = await render(<SettingsDrawer {...props({ ephemeral: true, backdrop: backdrop({}, { mode: 'image' }) })} />);
    expect(drawerText()).toContain('This browser can’t keep files here, so the image lasts until this tab closes.');
  });

  it('says what was wrong with an image', async () => {
    rendered = await render(<SettingsDrawer {...props({ backdrop: backdrop({ problem: 'That image is over 50 MB.' }, { mode: 'image' }) })} />);
    expect(document.querySelector('.ws-settings [role="alert"]')?.textContent).toBe('That image is over 50 MB.');
  });

  it('leaves Image out where there is nowhere to keep it', async () => {
    rendered = await render(<SettingsDrawer {...props({ backdrop: backdrop({ canUseImages: false }) })} />);
    expect(radios('Night background')).toEqual(['Starfield', 'Colour']);
  });
});

describe('Settings, Project, on a server project', () => {
  const server = { id: 'night-sky', name: 'Night Sky', color: '#7c8cff', created: '2026-10-22T00:00:00.000Z', createdBy: 'nebula', tier: 'server' as const };
  const serverProps = (patch: Partial<SettingsProps> = {}) =>
    props({ tab: 'project', project: server, serverPlace: { label: 'suite', folder: '' }, keptBy: 'suite', ...patch });
  const removed = (patch: Partial<RecentlyDeleted> = {}): RecentlyDeleted => ({ projects: [], error: null, busy: null, restore: vi.fn(), reload: vi.fn(), ...patch });
  const deleteButton = () => byLabel(document.body, 'Delete project…') as HTMLButtonElement | null;
  const spaceLine = () => document.querySelector('.ws-set-space');

  it('offers Delete project… where the server can delete, and it asks to remove', async () => {
    const onRemove = vi.fn();
    rendered = await render(<SettingsDrawer {...serverProps({ canDelete: true, onRemove })} />);
    expect(deleteButton()).not.toBeNull();
    expect(deleteButton()!.disabled).toBe(false);
    await click(deleteButton());
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('turns Delete project… off while the project list is locked', async () => {
    const onRemove = vi.fn();
    rendered = await render(<SettingsDrawer {...serverProps({ canDelete: true, canChangeProject: false, onRemove })} />);
    expect(deleteButton()!.disabled).toBe(true);
    await click(deleteButton());
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('has no button to remove where the server can’t delete', async () => {
    rendered = await render(<SettingsDrawer {...serverProps({ canDelete: false })} />);
    expect(deleteButton()).toBeNull();
    expect(byLabel(document.body, 'Remove project…')).toBeNull();
    expect(byLabel(document.body, 'Remove from Nebula…')).toBeNull();
  });

  it('keeps the browser and folder projects’ own remove buttons', async () => {
    rendered = await render(<SettingsDrawer {...props({ tab: 'project' })} />);
    expect(byLabel(document.body, 'Remove project…')).not.toBeNull();
    expect(deleteButton()).toBeNull();
    await rendered.unmount();
    rendered = await render(<SettingsDrawer {...props({ tab: 'project', project: { ...server, tier: 'folder' }, folderName: 'Night Sky' })} />);
    expect(byLabel(document.body, 'Remove from Nebula…')).not.toBeNull();
    expect(deleteButton()).toBeNull();
  });

  it('lists Recently deleted only where the host gives it, also with no project open', async () => {
    rendered = await render(<SettingsDrawer {...serverProps({ canDelete: true })} />);
    expect(document.querySelectorAll('.ws-removed-row')).toHaveLength(0);
    await rendered.rerender(<SettingsDrawer {...serverProps({ canDelete: true, recentlyDeleted: removed({ projects: [{ id: 'old', name: 'Old', color: '#fff', removed: 'x', purgeAfter: '2026-12-05T00:00:00.000Z' }] }) })} />);
    expect(document.querySelectorAll('.ws-removed-row')).toHaveLength(1);
    await rendered.rerender(<SettingsDrawer {...serverProps({ canDelete: true })} />);
    expect(document.querySelectorAll('.ws-removed-row')).toHaveLength(0); // taken away again
    await rendered.rerender(<SettingsDrawer {...props({ tab: 'project', project: null, recentlyDeleted: removed({ projects: [{ id: 'old', name: 'Old', color: '#fff', removed: 'x', purgeAfter: '2026-12-05T00:00:00.000Z' }] }) })} />);
    expect(document.querySelectorAll('.ws-removed-row')).toHaveLength(1);
  });

  it('shows the space the place sends, with a link for an http(s) upgrade only', async () => {
    rendered = await render(<SettingsDrawer {...serverProps({ space: { used: 120_000_000, limit: 1_000_000_000, upgrade: 'https://suite.test/plans' } })} />);
    expect(spaceLine()).not.toBeNull();
    const link = spaceLine()!.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://suite.test/plans');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    await rendered.rerender(<SettingsDrawer {...serverProps({ space: { used: 120_000_000, upgrade: 'javascript:alert(1)' } })} />);
    expect(spaceLine()).not.toBeNull();
    expect(spaceLine()!.querySelector('a')).toBeNull();
    await rendered.rerender(<SettingsDrawer {...serverProps({ space: { used: 120_000_000 } })} />);
    expect(spaceLine()!.querySelector('a')).toBeNull();
  });

  it('shows no space where the place sends none, or for a browser or folder project', async () => {
    rendered = await render(<SettingsDrawer {...serverProps({ space: null })} />);
    expect(spaceLine()).toBeNull();
    await rendered.rerender(<SettingsDrawer {...serverProps({ space: undefined })} />);
    expect(spaceLine()).toBeNull();
    await rendered.rerender(<SettingsDrawer {...props({ tab: 'project', space: { used: 1, limit: 2 } })} />);
    expect(spaceLine()).toBeNull();
    await rendered.rerender(<SettingsDrawer {...props({ tab: 'project', project: { ...server, tier: 'folder' }, folderName: 'Night Sky', space: { used: 1, limit: 2 } })} />);
    expect(spaceLine()).toBeNull();
  });
});
