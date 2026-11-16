import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFileStore, type MemoryFileStore } from '../../../../e2e/harness/views-store';
import type { FileEntry } from '../../../files/types';
import { ProjectLinksContext, type ProjectLinks } from '../shared/projectLinks';
import { click, render, waitFor, type Rendered } from '../testing/render';
import { formatCount } from '../shared/format';
import { countWords } from './markdown';
import NoteView from './NoteView';

// Task 2 of the reading lane: embeds in the reading view.

vi.mock('./embeds/canvasSvg', () => ({
  renderCanvasSvg: vi.fn(async () => new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'], { type: 'image/svg+xml' })),
}));
const canvasSvg = await import('./embeds/canvasSvg');
const renderCanvasSvg = vi.mocked(canvasSvg.renderCanvasSvg);

const PATH = 'Guides/Observing plan.md';
const PNG = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });

let store: MemoryFileStore;
let readBlobs: string[];
let files: Record<string, string | Blob>;
const mounted: Rendered[] = [];
let revoked: string[];
let made: number;

class FakeObserver {
  static all: FakeObserver[] = [];
  elements: Element[] = [];
  callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeObserver.all.push(this);
  }
  observe(element: Element) {
    this.elements.push(element);
    // As the real one does: a first answer at once, from where the element is now (off screen).
    queueMicrotask(() => this.callback([{ isIntersecting: false, target: element } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
  }
  unobserve() {}
  disconnect() {
    this.elements = [];
  }
  static async scrollIntoView() {
    await act(async () => {
      for (const observer of FakeObserver.all) {
        if (observer.elements.length === 0) continue;
        observer.callback(observer.elements.map((target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry), observer as unknown as IntersectionObserver);
      }
    });
  }
}

beforeEach(() => {
  made = 0;
  revoked = [];
  readBlobs = [];
  FakeObserver.all = [];
  renderCanvasSvg.mockClear();
  URL.createObjectURL = vi.fn(() => `blob:test/${(made += 1)}`);
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
  files = {};
});

afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
  document.body.innerHTML = '';
});

function entryOf(path: string, data: string | Blob): FileEntry {
  return { path, name: path.split('/').pop()!, type: 'file', size: typeof data === 'string' ? data.length : data.size, modified: 1 };
}

async function open(source: string, more: Record<string, string | Blob> = {}, path = PATH, extra: Partial<ProjectLinks> = {}) {
  files = { [PATH]: source, ...more };
  store = createMemoryFileStore(files);
  const readBlob = store.readBlob.bind(store);
  store.readBlob = async (target) => {
    readBlobs.push(target);
    return readBlob(target);
  };
  const project: ProjectLinks = { files: Object.entries(files).map(([p, d]) => entryOf(p, d)), open: vi.fn(), create: vi.fn(), ...extra };
  const onStatus = vi.fn();
  const view = await render(
    <ProjectLinksContext.Provider value={project}>
      <NoteView projectId="p" store={store} entry={entryOf(path, files[path])} kind="note" onStatus={onStatus} />
    </ProjectLinksContext.Provider>,
  );
  mounted.push(view);
  await waitFor(() => expect(view.container.querySelector('.ws-prose')).not.toBeNull());
  return { view, project, prose: view.container.querySelector('.ws-prose') as HTMLElement, onStatus };
}

describe('images in the project', () => {
  it('wait until they are near the screen, then show as a lazy image with the file’s name as its words', async () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const { prose } = await open('Before.\n\n![[Photos/a.png]]\n\nAfter.', { 'Photos/a.png': PNG() });
    expect(prose.querySelector('img')).toBeNull();
    expect(readBlobs).toEqual([]);
    expect(prose.querySelector('.ws-embed-image')).not.toBeNull();
    await FakeObserver.scrollIntoView();
    await waitFor(() => expect(prose.querySelector('img')).not.toBeNull());
    const image = prose.querySelector('img')!;
    expect(image.getAttribute('loading')).toBe('lazy');
    expect(image.getAttribute('src')).toMatch(/^blob:test\//);
    expect(image.alt).toBe('a.png');
    expect(readBlobs).toEqual(['Photos/a.png']);
  });

  it('take a width, or width and height, and a caption as their words', async () => {
    const { prose } = await open('![[a.png|300]]\n\n![[a.png|300x200]]\n\n![[a.png|a caption]]', { 'a.png': PNG() });
    await waitFor(() => expect(prose.querySelectorAll('img')).toHaveLength(3));
    const [width, both, caption] = [...prose.querySelectorAll('img')];
    expect(width.style.width).toBe('300px');
    expect(width.style.height).toBe('');
    expect([both.style.width, both.style.height]).toEqual(['300px', '200px']);
    expect(caption.alt).toBe('a caption');
    expect(caption.style.width).toBe('');
  });

  it('follow a markdown address relative to the note, with %20 decoded and <…> for spaces', async () => {
    const { prose } = await open('![A photo](Photos/x.png)\n\n![](<../Photos/my image.png>)\n\n![](../Photos/my%20image.png)', {
      'Guides/Photos/x.png': PNG(),
      'Photos/my image.png': PNG(),
    });
    await waitFor(() => expect(prose.querySelectorAll('img')).toHaveLength(3));
    expect([...prose.querySelectorAll('img')].map((image) => image.alt)).toEqual(['A photo', 'my image.png', 'my image.png']);
    expect(readBlobs.sort()).toEqual(['Guides/Photos/x.png', 'Photos/my image.png', 'Photos/my image.png']);
  });

  it('show a muted placeholder with the name, never a broken image, for a file that isn’t there', async () => {
    const { prose } = await open('![[nope.png]] and ![a photo](Photos/a.jpg) and ![](Photos/b.jpg)');
    expect(prose.querySelector('img')).toBeNull();
    const missing = [...prose.querySelectorAll('.ws-embed-missing')];
    expect(missing.map((item) => item.textContent)).toEqual(['nope.png', 'a photo', 'b.jpg']);
  });

  it('give their blob URL back when the note goes', async () => {
    const { prose, view } = await open('![[a.png]]', { 'a.png': PNG() });
    await waitFor(() => expect(prose.querySelector('img')).not.toBeNull());
    const url = prose.querySelector('img')!.getAttribute('src')!;
    await view.unmount();
    mounted.splice(mounted.indexOf(view), 1);
    expect(revoked).toContain(url);
  });

  it('show an SVG as an image, so nothing in it runs', async () => {
    const { prose } = await open('![[mark.svg]]', { 'mark.svg': new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>window.__pwned=1</script></svg>']) });
    await waitFor(() => expect(prose.querySelector('img')).not.toBeNull());
    expect(prose.querySelector('svg')).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('still hold a web image back until it is asked for', async () => {
    const { prose } = await open('![t](https://tracker.example/p.png)');
    expect(prose.querySelector('img')).toBeNull();
    expect(prose.querySelector('.ws-remote-image')?.textContent).toContain('tracker.example');
  });
});

describe('a canvas embed', () => {
  const CANVAS = 'Sketches/Winter hexagon.excalidraw.md';

  it('waits until it is on screen, then shows the drawing as an image of an SVG blob, and opens the canvas on a click', async () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const { prose, project } = await open('![[Winter hexagon.excalidraw]]', { [CANVAS]: '---\nexcalidraw-plugin: parsed\n---\n' });
    expect(prose.querySelector('img')).toBeNull();
    expect(renderCanvasSvg).not.toHaveBeenCalled();
    expect(prose.querySelector('.ws-embed-canvas')?.textContent).toContain('Winter hexagon');
    await FakeObserver.scrollIntoView();
    await waitFor(() => expect(prose.querySelector('.ws-embed-canvas img')).not.toBeNull());
    const image = prose.querySelector<HTMLImageElement>('.ws-embed-canvas img')!;
    expect(image.getAttribute('src')).toMatch(/^blob:test\//);
    expect(image.alt).toBe('Winter hexagon');
    expect(renderCanvasSvg).toHaveBeenCalledTimes(1);
    expect(renderCanvasSvg.mock.calls[0][1]).toBe(CANVAS);
    expect((URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toMatchObject({ type: 'image/svg+xml' });
    const button = prose.querySelector<HTMLButtonElement>('button.ws-embed-canvas')!;
    expect(button.getAttribute('aria-label')).toBe('Open Winter hexagon');
    await click(button);
    expect(project.open).toHaveBeenCalledWith(CANVAS);
  });

  it('is drawn for the app’s theme, night or day', async () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    await open('![[Winter hexagon.excalidraw]]', { [CANVAS]: 'x' });
    await waitFor(() => expect(renderCanvasSvg).toHaveBeenCalled());
    expect(renderCanvasSvg.mock.calls[0][2]).toBe('dark');
  });

  it('shows its name as a link, and never fails the note, when the export fails', async () => {
    renderCanvasSvg.mockRejectedValueOnce(new Error('not a drawing'));
    const { prose, project } = await open('Before\n\n![[Winter hexagon.excalidraw]]\n\nAfter', { [CANVAS]: 'not a drawing' });
    await waitFor(() => expect(prose.querySelector('.ws-embed-canvas-failed')).not.toBeNull());
    expect(prose.textContent).toContain('After');
    const link = prose.querySelector<HTMLElement>('.ws-embed-canvas-failed')!;
    expect(link.textContent).toContain('Winter hexagon');
    await click(link);
    expect(project.open).toHaveBeenCalledWith(CANVAS, undefined);
  });

  it('shows a missing canvas as the muted name', async () => {
    const { prose } = await open('![[Nothing.excalidraw]]');
    expect(prose.querySelector('.ws-embed-missing')?.textContent).toBe('Nothing.excalidraw');
    expect(renderCanvasSvg).not.toHaveBeenCalled();
  });

  it('takes a plain .md that is an Excalidraw drawing for a canvas', async () => {
    const { prose } = await open('![[Drawing]]', { 'Guides/Drawing.md': '---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data\n' });
    await waitFor(() => expect(prose.querySelector('.ws-embed-canvas img')).not.toBeNull());
    expect(prose.querySelector('.ws-embed-note')).toBeNull();
  });
});

describe('a note embed', () => {
  it('shows the note read-only, in a block with its name as a link to it', async () => {
    const { prose, project } = await open('![[Orion]]', { 'Guides/Orion.md': '# Orion\n\nThe Hunter.\n\n- [ ] A task\n\n## Stars\n\nRigel.\n' });
    await waitFor(() => expect(prose.querySelector('.ws-embed-note .ws-embed-body')).not.toBeNull());
    const block = prose.querySelector('.ws-embed-note')!;
    expect(block.querySelector('.ws-embed-body')?.textContent).toContain('The Hunter.');
    // The first heading that only repeats the name isn't said twice.
    expect(block.querySelector('h1')).toBeNull();
    expect(block.querySelector('h2')?.textContent).toBe('Stars');
    expect(block.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);
    const name = block.querySelector<HTMLElement>('.ws-embed-name')!;
    expect(name.textContent).toBe('Orion');
    await click(name);
    expect(project.open).toHaveBeenCalledWith('Guides/Orion.md', undefined);
    expect(prose.querySelector('p .ws-embed-note')).toBeNull();
  });

  it('shows only the section a heading names, or the paragraph a block id names', async () => {
    const { prose } = await open('![[Orion#Stars]]\n\n![[Orion#^belt]]', {
      'Guides/Orion.md': 'Intro.\n\n## Stars\n\nRigel.\n\n## Nebula\n\nM42.\n\nThe Belt. ^belt\n',
    });
    await waitFor(() => expect(prose.querySelectorAll('.ws-embed-note .ws-embed-body')).toHaveLength(2));
    const [section, block] = [...prose.querySelectorAll('.ws-embed-note .ws-embed-body')];
    expect(section.textContent).toContain('Rigel.');
    expect(section.textContent).not.toContain('Intro.');
    expect(section.textContent).not.toContain('M42.');
    expect(block.textContent?.trim()).toBe('The Belt.');
  });

  it('shows the whole note when its section isn’t there', async () => {
    const { prose } = await open('![[Orion#Nope]]', { 'Guides/Orion.md': 'Intro.\n\n## Stars\n' });
    await waitFor(() => expect(prose.querySelector('.ws-embed-body')?.textContent).toContain('Intro.'));
  });

  it('stops a note that embeds itself, with a muted line', async () => {
    const { prose } = await open('Top\n\n![[Observing plan]]');
    expect(prose.querySelector('.ws-embed-note')?.textContent).toContain('embeds itself');
    expect(prose.querySelectorAll('.ws-embed-note')).toHaveLength(1);
  });

  it('stops two notes that embed each other', async () => {
    const { prose } = await open('![[A]]', { 'Guides/A.md': 'In A.\n\n![[B]]', 'Guides/B.md': 'In B.\n\n![[A]]' });
    await waitFor(() => expect(prose.textContent).toContain('embeds itself'));
    expect(prose.textContent).toContain('In A.');
    expect(prose.textContent).toContain('In B.');
    expect(prose.querySelectorAll('.ws-embed-note')).toHaveLength(3);
    expect(prose.querySelectorAll('.ws-embed-stop')).toHaveLength(1);
  });

  it('goes two deep, and past that offers a link instead', async () => {
    const { prose } = await open('![[A]]', { 'Guides/A.md': 'In A.\n\n![[B]]', 'Guides/B.md': 'In B.\n\n![[C]]', 'Guides/C.md': 'In C.' });
    await waitFor(() => expect(prose.textContent).toContain('In B.'));
    expect(prose.textContent).not.toContain('In C.');
    expect(prose.querySelector('.ws-embed-deep')?.textContent).toContain('C');
  });

  it('is cut at 20,000 characters, with a link to the rest', async () => {
    const long = `${'Seeing was steady after midnight.\n\n'.repeat(700)}THE END`;
    const { prose, project } = await open('![[Log]]', { 'Guides/Log.md': long });
    await waitFor(() => expect(prose.querySelector('.ws-embed-body')).not.toBeNull());
    const shown = prose.querySelector('.ws-embed-body')!.textContent!;
    expect(shown.length).toBeLessThanOrEqual(20_000);
    expect(shown).not.toContain('THE END');
    const more = prose.querySelector<HTMLElement>('.ws-embed-more')!;
    expect(more.textContent).toBe('Open the note');
    await click(more);
    expect(project.open).toHaveBeenCalledWith('Guides/Log.md');
  });

  it('never renders raw HTML from the embedded note either', async () => {
    const { prose } = await open('![[Odd]]', { 'Guides/Odd.md': '<img src="x" onerror="window.__pwned2 = true">\n\ntext' });
    await waitFor(() => expect(prose.querySelector('.ws-embed-body')).not.toBeNull());
    expect(prose.querySelector('.ws-embed-body img')).toBeNull();
    expect((window as { __pwned2?: boolean }).__pwned2).toBeUndefined();
  });

  it('is a link, not a block, when it sits in a line of text', async () => {
    const { prose } = await open('See ![[Orion]] for more.', { 'Guides/Orion.md': 'The Hunter.' });
    expect(prose.querySelector('.ws-embed-note')).toBeNull();
    expect(prose.querySelector('p .ws-wikilink')?.textContent).toBe('Orion');
  });

  it('resolves the links of the embedded note from its own folder', async () => {
    const { prose, project } = await open('![[Notes/Inner]]', { 'Notes/Inner.md': 'See [[Sibling]].', 'Notes/Sibling.md': 'x', 'Guides/Sibling.md': 'y' });
    await waitFor(() => expect(prose.querySelector('.ws-embed-body .ws-wikilink')).not.toBeNull());
    await click(prose.querySelector('.ws-embed-body .ws-wikilink'));
    expect(project.open).toHaveBeenCalledWith('Notes/Sibling.md', undefined);
  });

  it('adds no words to the count, and no headings to the page', async () => {
    const withEmbed = await open('Alpha beta gamma.\n\n![[Orion]]', { 'Guides/Orion.md': '## Stars\n\n' + 'many words '.repeat(50) });
    await waitFor(() => expect(withEmbed.onStatus).toHaveBeenCalled());
    expect(withEmbed.onStatus.mock.calls.at(-1)?.[0]).toBe(formatCount(countWords('Alpha beta gamma.\n\n![[Orion]]'), 'word'));
    expect(withEmbed.prose.textContent).toContain('many words');
  });
});

describe('other files', () => {
  it('shows a PDF as a small card with its name and size, and opens it on a click', async () => {
    const { prose, project } = await open('![[Star chart.pdf]]', { 'Charts/Star chart.pdf': new Blob([new Uint8Array(96_000)]) });
    const card = prose.querySelector('.ws-embed-card')!;
    expect(card.textContent).toContain('Star chart.pdf');
    expect(card.textContent).toContain('96 KB');
    expect(prose.querySelector('iframe, embed, object')).toBeNull();
    expect(readBlobs).toEqual([]);
    await click(card.querySelector('button'));
    expect(project.open).toHaveBeenCalledWith('Charts/Star chart.pdf');
  });

  it('plays audio and video with the browser’s own controls, and loads nothing until asked', async () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const { prose } = await open('![[Crickets.m4a]]\n\n![[Moonrise.mp4]]', { 'Crickets.m4a': new Blob([new Uint8Array(10)]), 'Moonrise.mp4': new Blob([new Uint8Array(10)]) });
    expect(prose.querySelector('audio, video')).toBeNull();
    await FakeObserver.scrollIntoView();
    await waitFor(() => expect(prose.querySelector('audio')).not.toBeNull());
    const audio = prose.querySelector('audio')!;
    const video = prose.querySelector('video')!;
    expect([audio.controls, video.controls]).toEqual([true, true]);
    expect([audio.getAttribute('preload'), video.getAttribute('preload')]).toEqual(['none', 'none']);
    expect(audio.getAttribute('src')).toMatch(/^blob:test\//);
  });

  it('shows any other file as a card', async () => {
    const { prose } = await open('![[data.zip]] and ![[notes.txt]]', { 'data.zip': new Blob([new Uint8Array(5)]), 'notes.txt': 'hi' });
    expect([...prose.querySelectorAll('.ws-embed-card')].map((card) => card.textContent)).toEqual([expect.stringContaining('data.zip'), expect.stringContaining('notes.txt')]);
  });
});
