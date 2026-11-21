import { describe, expect, it } from 'vitest';

// The load budget: the note editor's chunk holds no Excalidraw. A note's pasted image is kept through
// attachments.ts, which the canvas shares, and that module must stay free of drawing code. This reads the editor's
// static imports from source (a built chunk's map is the e2e budget spec's), so it fails before any build.

const sources = import.meta.glob('../../../../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** `src/…` for a key of the glob, which is relative to this file. */
const absolute = (key: string) => {
  const parts = `src/workspace/views/note/editor/${key}`.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part !== '.') out.push(part);
  }
  return out.join('/');
};
const byPath = new Map(Object.entries(sources).map(([key, text]) => [absolute(key), text]));

const STATIC_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

function resolve(from: string, specifier: string): string | null {
  const parts = from.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  const base = parts.join('/');
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base].find((candidate) => byPath.has(candidate)) ?? null;
}

/** Everything `entry` imports statically, its own files and the packages it names. */
function staticGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  for (let path = queue.shift(); path; path = queue.shift()) {
    if (files.has(path)) continue;
    files.add(path);
    for (const match of byPath.get(path)!.matchAll(STATIC_IMPORT)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) packages.add(specifier);
      else {
        const next = resolve(path, specifier);
        if (next && !/\.(css|svg|png)$/.test(next)) queue.push(next);
      }
    }
  }
  return { files, packages };
}

describe('the note editor’s static imports', () => {
  const graph = staticGraph('src/workspace/views/note/editor/NoteEditor.tsx');

  it('reach the shared attachments module (the reader works, so the check below means something)', () => {
    expect(graph.files.has('src/workspace/attachments.ts')).toBe(true);
    expect(graph.files.has('src/workspace/views/note/editor/imageFiles.ts')).toBe(true);
    expect(graph.packages.has('@codemirror/view')).toBe(true);
  });

  it('reach no canvas shell, no canvas image code, and no Excalidraw', () => {
    const drawing = [...graph.files].filter((path) => /\/views\/canvas\/|canvasImages|fileSceneStore|moveImagesOut|\/nebula\/excalidraw\//.test(path));
    expect(drawing).toEqual([]);
    expect([...graph.packages].filter((name) => /excalidraw/i.test(name))).toEqual([]);
  });

  it('catch a drawing import when there is one (the walker sees a file’s static imports)', () => {
    // The canvas's own module does import drawing code: the same walk finds it.
    const canvas = staticGraph('src/workspace/views/canvas/fileSceneStore.ts');
    expect([...canvas.files].some((path) => path.includes('excalidraw/'))).toBe(true);
  });
});
