import { describe, expect, it } from 'vitest';
import type { FileEntry, WorkspaceState } from '../files/types';
import { EMPTY_WORKSPACE, parseWorkspaceState, serializeWorkspaceState, workspaceReducer as reduce } from './workspaceState';

const state = (patch: Partial<WorkspaceState>): WorkspaceState => ({ ...EMPTY_WORKSPACE, ...patch });

describe('tabs', () => {
  it('opens a file in a new tab and makes it active', () => {
    const next = reduce(state({ tabs: ['a.md'], active: 'a.md' }), { type: 'open', path: 'b.md' });
    expect(next).toMatchObject({ tabs: ['a.md', 'b.md'], active: 'b.md' });
  });

  it('only focuses a file that is already open', () => {
    const next = reduce(state({ tabs: ['a.md', 'b.md'], active: 'b.md' }), { type: 'open', path: 'a.md' });
    expect(next).toMatchObject({ tabs: ['a.md', 'b.md'], active: 'a.md' });
  });

  it('hands the focus to the next tab when the active one closes, or the previous at the end', () => {
    const three = state({ tabs: ['a.md', 'b.md', 'c.md'], active: 'b.md' });
    expect(reduce(three, { type: 'close', path: 'b.md' })).toMatchObject({ tabs: ['a.md', 'c.md'], active: 'c.md' });
    const last = state({ tabs: ['a.md', 'b.md'], active: 'b.md' });
    expect(reduce(last, { type: 'close', path: 'b.md' })).toMatchObject({ tabs: ['a.md'], active: 'a.md' });
    const only = state({ tabs: ['a.md'], active: 'a.md' });
    expect(reduce(only, { type: 'close', path: 'a.md' })).toMatchObject({ tabs: [], active: null });
  });

  it('leaves the active tab alone when another closes', () => {
    const next = reduce(state({ tabs: ['a.md', 'b.md'], active: 'b.md' }), { type: 'close', path: 'a.md' });
    expect(next).toMatchObject({ tabs: ['b.md'], active: 'b.md' });
  });

  it('moves a tab to a new place in the order', () => {
    const tabs = state({ tabs: ['a.md', 'b.md', 'c.md'], active: 'a.md' });
    expect(reduce(tabs, { type: 'moveTab', path: 'a.md', to: 2 }).tabs).toEqual(['b.md', 'c.md', 'a.md']);
    expect(reduce(tabs, { type: 'moveTab', path: 'c.md', to: 0 }).tabs).toEqual(['c.md', 'a.md', 'b.md']);
  });
});

describe('folders and stars', () => {
  it('expands and folds a folder', () => {
    const open = reduce(EMPTY_WORKSPACE, { type: 'toggleExpanded', path: 'Guides' });
    expect(open.expanded).toEqual(['Guides']);
    expect(reduce(open, { type: 'toggleExpanded', path: 'Guides' }).expanded).toEqual([]);
  });

  it('reveals a file by expanding every folder above it', () => {
    const next = reduce(state({ expanded: ['Photos'] }), { type: 'reveal', path: 'Guides/Deep/M42.md' });
    expect(new Set(next.expanded)).toEqual(new Set(['Photos', 'Guides', 'Guides/Deep']));
  });

  it('stars in the order things were starred, and unstars', () => {
    let next = reduce(EMPTY_WORKSPACE, { type: 'toggleStar', path: 'b.md' });
    next = reduce(next, { type: 'toggleStar', path: 'Guides' });
    expect(next.starred).toEqual(['b.md', 'Guides']);
    expect(reduce(next, { type: 'toggleStar', path: 'b.md' }).starred).toEqual(['Guides']);
  });
});

describe('renames and removals', () => {
  const before = state({
    tabs: ['Guides/Orion.md', 'README.md', 'Guides/Deep/M42.md'],
    active: 'Guides/Deep/M42.md',
    expanded: ['Guides', 'Guides/Deep'],
    starred: ['Guides/Orion.md', 'Guides'],
  });

  it('follows a renamed folder into every list', () => {
    const next = reduce(before, { type: 'renamed', from: 'Guides', to: 'Notes' });
    expect(next).toEqual({
      tabs: ['Notes/Orion.md', 'README.md', 'Notes/Deep/M42.md'],
      active: 'Notes/Deep/M42.md',
      expanded: ['Notes', 'Notes/Deep'],
      starred: ['Notes/Orion.md', 'Notes'],
    });
  });

  it('follows a renamed file', () => {
    const next = reduce(before, { type: 'renamed', from: 'README.md', to: 'Start here.md' });
    expect(next.tabs).toEqual(['Guides/Orion.md', 'Start here.md', 'Guides/Deep/M42.md']);
  });

  it('drops everything inside a removed folder, and moves the focus to what is left', () => {
    const next = reduce(before, { type: 'removed', path: 'Guides' });
    expect(next).toEqual({ tabs: ['README.md'], active: 'README.md', expanded: [], starred: [] });
  });

  it('prunes what no longer exists: tabs need files, folds need folders', () => {
    const entries: FileEntry[] = [
      { path: 'Guides', name: 'Guides', type: 'dir' },
      { path: 'Guides/Orion.md', name: 'Orion.md', type: 'file' },
      { path: 'README.md', name: 'README.md', type: 'file' },
    ];
    const next = reduce(before, { type: 'prune', entries });
    expect(next).toEqual({
      tabs: ['Guides/Orion.md', 'README.md'],
      active: 'README.md',
      expanded: ['Guides'],
      starred: ['Guides/Orion.md', 'Guides'],
    });
  });
});

describe('workspace.json', () => {
  it('round-trips', () => {
    const saved = state({ tabs: ['a.md'], active: 'a.md', expanded: ['Guides'], starred: ['a.md'] });
    expect(parseWorkspaceState(serializeWorkspaceState(saved))).toEqual(saved);
  });

  it('starts empty from nothing, from broken JSON and from the wrong shape', () => {
    expect(parseWorkspaceState(null)).toEqual(EMPTY_WORKSPACE);
    expect(parseWorkspaceState('{"tabs": [')).toEqual(EMPTY_WORKSPACE);
    expect(parseWorkspaceState('[1, 2]')).toEqual(EMPTY_WORKSPACE);
  });

  it('keeps the good parts of a damaged file', () => {
    const text = JSON.stringify({ tabs: ['a.md', 7, 'a.md', 'b.md'], active: 'zzz.md', expanded: 'Guides', starred: [null, 'b.md'] });
    expect(parseWorkspaceState(text)).toEqual({ tabs: ['a.md', 'b.md'], active: 'a.md', expanded: [], starred: ['b.md'] });
  });
});
