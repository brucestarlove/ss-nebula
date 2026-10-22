import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from './dev/memoryStore';
import { resolveKind } from './fileKind';

// The file tree checks every plain .md as soon as a project opens, so the
// check must not reach for the canvas code (src/files/kinds.ts has a copy of
// the test for exactly this). Loading that module fails here.
vi.mock('../nebula/excalidraw/obsidianMarkdown', () => {
  throw new Error('the tree loaded the canvas code');
});

describe('resolveKind', () => {
  const store = new MemoryStore({
    'plain.md': '# Plain\n\nJust words.',
    'drawing.md': '---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n# Excalidraw Data\n## Drawing\n```json\n{"elements":[]}\n```\n',
    'empty.excalidraw.md': '',
    'photo.png': 'x',
  });
  const entry = (path: string) => ({ path, name: path, type: 'file' as const });

  it('takes the name when it says enough', async () => {
    expect(await resolveKind(store, entry('photo.png'))).toBe('image');
    expect(await resolveKind(store, entry('empty.excalidraw.md'))).toBe('canvas');
  });

  it('reads a plain .md to tell a drawing from a note, without the canvas code', async () => {
    expect(await resolveKind(store, entry('plain.md'))).toBe('note');
    expect(await resolveKind(store, entry('drawing.md'))).toBe('canvas');
  });

  it('calls a .md it cannot read a note', async () => {
    expect(await resolveKind(store, entry('missing.md'))).toBe('note');
  });
});
