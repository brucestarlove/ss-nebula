import { describe, expect, it } from 'vitest';

import hexagonText from '../../e2e/assets/images/winter-hexagon.excalidraw?raw';
import { readObsidianExcalidrawMarkdown, toObsidianExcalidrawMarkdown } from '../nebula/excalidraw/obsidianMarkdown';
import type { ExcalidrawScene } from '../nebula/excalidraw/scene';
import { blobToBytes } from './bytes';
import { kindFromName } from './kinds';
import { MemoryFileStore } from './memoryStore';
import { basename } from './paths';
import { createBrowserRegistry } from './registry';
import { SAMPLE_PROJECT, seedSampleProject } from './sample';
import sampleCanvas from './sample/Winter hexagon.excalidraw.md?raw';
import { readWorkspaceState } from './workspaceState';

type Fs = { readFileSync(path: string): Uint8Array; readdirSync(path: string): string[] };
const fs = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown } }).process.getBuiltinModule('node:fs') as Fs;

/** fetch() for public/, read from disk, recording what was asked for. */
function publicFetch(options: { missing?: string[] } = {}) {
  const requested: string[] = [];
  const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    requested.push(url);
    const name = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
    if (options.missing?.includes(name)) return new Response('Not found', { status: 404 });
    const bytes = fs.readFileSync(`public/sample/${name}`);
    return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array(bytes)]) } as unknown as Response;
  };
  return { fetch: fetcher as typeof fetch, requested };
}

async function seeded(options: { missing?: string[]; baseUrl?: string } = {}) {
  const registry = createBrowserRegistry(new MemoryFileStore());
  const fetcher = publicFetch(options);
  const result = await seedSampleProject(registry, { fetch: fetcher.fetch, baseUrl: options.baseUrl });
  return { registry, result, store: await registry.files(result.project.id), requested: fetcher.requested };
}

const SAMPLE_PATHS = [
  'Charts',
  'Charts/Star chart — October.pdf',
  'Guides',
  'Guides/Moon phases.md',
  'Guides/Observing plan.md',
  'Guides/Orion.md',
  'Photos',
  'Photos/Winter hexagon.png',
  'README.md',
  'Sketches',
  'Sketches/Winter hexagon.excalidraw.md',
];

describe('seedSampleProject', () => {
  it('creates Night Sky, in periwinkle, with its notes, canvas, image and PDF', async () => {
    const { registry, result, store } = await seeded();
    expect(SAMPLE_PROJECT).toEqual({ name: 'Night Sky', color: '#7c8cff' });
    expect(result.project).toMatchObject({ name: 'Night Sky', color: '#7c8cff' });
    expect(result.missing).toEqual([]);
    expect((await registry.list()).map((project) => project.name)).toEqual(['Night Sky']);
    expect((await store.list()).map((entry) => entry.path)).toEqual(SAMPLE_PATHS);
  });

  it('fetches the image and the PDF from public/sample, and copies them byte for byte', async () => {
    const { store, requested } = await seeded();
    expect(requested).toEqual(['/sample/winter-hexagon.png', '/sample/star-chart.pdf']);
    const png = await blobToBytes(await store.readBlob('Photos/Winter hexagon.png'));
    const pdf = await blobToBytes(await store.readBlob('Charts/Star chart — October.pdf'));
    expect(png).toEqual(new Uint8Array(fs.readFileSync('public/sample/winter-hexagon.png')));
    expect(pdf).toEqual(new Uint8Array(fs.readFileSync('public/sample/star-chart.pdf')));
    expect(Array.from(png.slice(1, 4), (byte) => String.fromCharCode(byte)).join('')).toBe('PNG');
    expect(Array.from(pdf.slice(0, 5), (byte) => String.fromCharCode(byte)).join('')).toBe('%PDF-');
  });

  it('can fetch from another base URL', async () => {
    const { requested } = await seeded({ baseUrl: 'https://nebula.example/app/sample/' });
    expect(requested).toEqual(['https://nebula.example/app/sample/winter-hexagon.png', 'https://nebula.example/app/sample/star-chart.pdf']);
  });

  it("writes the sketch's observing plan as markdown, task list included", async () => {
    const { store } = await seeded();
    const plan = await store.readText('Guides/Observing plan.md');
    expect(plan).toContain('# Observing plan');
    expect(plan).toContain('Saturday, after moonset.');
    expect(plan).toContain('## Targets\n\n- [x] Orion Nebula (M42), low in the east after 11 pm. Notes in [[Orion]].\n- [ ] The Pleiades (M45). Binoculars first, then the scope.\n- [ ] Andromeda (M31), before it drops into the trees.');
    expect(plan).toContain('## Pack');
    expect(plan).toContain('> Give your eyes twenty minutes in the dark before you judge the sky.');
  });

  it("makes the canvas from the sketch's winter hexagon, in Obsidian's compressed format", async () => {
    const { store } = await seeded();
    const hexagon = JSON.parse(hexagonText) as ExcalidrawScene;
    const text = await store.readText('Sketches/Winter hexagon.excalidraw.md');

    expect(text).toBe(toObsidianExcalidrawMarkdown(hexagon, { compressed: true }));
    expect(text).toBe(sampleCanvas);
    expect(readObsidianExcalidrawMarkdown(text).elements).toEqual(hexagon.elements.map((element) => ({ ...element, boundElements: element.boundElements ?? [] })));
    expect(kindFromName('Sketches/Winter hexagon.excalidraw.md')).toBe('canvas');
  });

  it('opens on the observing plan, with the starred files the sketch shows', async () => {
    const { store } = await seeded();
    expect(await readWorkspaceState(store)).toEqual({
      tabs: ['Guides/Observing plan.md', 'Sketches/Winter hexagon.excalidraw.md', 'Photos/Winter hexagon.png'],
      active: 'Guides/Observing plan.md',
      expanded: ['Guides', 'Sketches', 'Photos'],
      starred: ['Guides/Observing plan.md', 'Sketches/Winter hexagon.excalidraw.md'],
    });
  });

  it("still makes the project when a file can't be fetched, and says which is missing", async () => {
    const { result, store } = await seeded({ missing: ['winter-hexagon.png'] });
    expect(result.missing).toEqual(['Photos/Winter hexagon.png']);
    expect((await store.list()).map((entry) => entry.path)).toEqual(SAMPLE_PATHS.filter((path) => path !== 'Photos/Winter hexagon.png' && path !== 'Photos'));
    expect((await readWorkspaceState(store)).tabs).toEqual(['Guides/Observing plan.md', 'Sketches/Winter hexagon.excalidraw.md']);
  });

  it('links only to files that are in the project', async () => {
    const { store } = await seeded();
    const paths = (await store.list()).filter((entry) => entry.type === 'file').map((entry) => entry.path);
    for (const note of paths.filter((path) => path.endsWith('.md') && !path.endsWith('.excalidraw.md'))) {
      const text = await store.readText(note);
      for (const [, target] of text.matchAll(/!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
        const found = paths.some((path) => basename(path) === target || basename(path) === `${target}.md`);
        expect(found, `${note} links to [[${target}]]`).toBe(true);
      }
    }
  });
});

describe('public/sample', () => {
  it('credits every file it holds', () => {
    const credits = new TextDecoder().decode(fs.readFileSync('public/sample/CREDITS.md'));
    for (const name of fs.readdirSync('public/sample').filter((file) => file !== 'CREDITS.md')) {
      expect(credits, name).toContain(`\`${name}\``);
    }
  });
});
