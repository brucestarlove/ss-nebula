import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFileStore } from '../../../../e2e/harness/views-store';
import type { FileEntry } from '../../../files/types';
import { ProjectLinksContext, type ProjectLinks } from '../shared/projectLinks';
import { click, render, waitFor, type Rendered } from '../testing/render';
import NoteView from './NoteView';

// Task 1 of the reading lane: [[links]] in the reading view are real links.

const PATH = 'Guides/Observing plan.md';
const file = (path: string): FileEntry => ({ path, name: path.split('/').pop()!, type: 'file', size: 10 });
const FILES = [PATH, 'Guides/Orion.md', 'Charts/Star chart — October.pdf', 'Sketches/Winter hexagon.excalidraw.md'].map(file);

const mounted: Rendered[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
  document.body.innerHTML = '';
});

async function open(source: string, links: Partial<ProjectLinks> = {}) {
  const store = createMemoryFileStore({ [PATH]: source });
  const project: ProjectLinks = { files: FILES, open: vi.fn(), create: vi.fn(), ...links };
  const view = await render(
    <ProjectLinksContext.Provider value={project}>
      <NoteView projectId="p" store={store} entry={file(PATH)} kind="note" />
    </ProjectLinksContext.Provider>,
  );
  mounted.push(view);
  await waitFor(() => expect(view.container.querySelector('.ws-prose')).not.toBeNull());
  return { view, project, prose: view.container.querySelector('.ws-prose')! };
}

const links = (prose: Element) => [...prose.querySelectorAll<HTMLElement>('.ws-wikilink')];

describe('[[wikilinks]] in the reading view', () => {
  it('is a link by role, reachable by keyboard, named for the file it opens', async () => {
    const { prose } = await open('Notes in [[Orion]].');
    const [link] = links(prose);
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('role')).toBe('link');
    expect(link.tabIndex).toBe(0);
    expect(link.textContent).toBe('Orion');
    expect(link.title).toBe('Guides/Orion.md');
    expect(link.classList.contains('ws-wikilink-missing')).toBe(false);
  });

  it('opens the file on a click, and on Enter', async () => {
    const { prose, project } = await open('Notes in [[Orion]].');
    await click(links(prose)[0]);
    expect(project.open).toHaveBeenLastCalledWith('Guides/Orion.md', undefined);
    const { act } = await import('react');
    await act(async () => {
      links(prose)[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(project.open).toHaveBeenCalledTimes(2);
  });

  it('resolves from the note’s own folder, and opens any kind of file', async () => {
    const { prose, project } = await open('[[Star chart — October.pdf|the chart]] and [[Winter hexagon.excalidraw]]');
    const [chart, canvas] = links(prose);
    expect(chart.textContent).toBe('the chart');
    await click(chart);
    expect(project.open).toHaveBeenLastCalledWith('Charts/Star chart — October.pdf', undefined);
    await click(canvas);
    expect(project.open).toHaveBeenLastCalledWith('Sketches/Winter hexagon.excalidraw.md', undefined);
  });

  it('shows an alias, and a heading link as “Note > Heading”', async () => {
    const { prose } = await open('[[Orion|the hunter]] [[Orion#Stars]] [[#Targets]]');
    expect(links(prose).map((link) => link.textContent)).toEqual(['the hunter', 'Orion > Stars', 'Targets']);
  });

  it('opens a heading link at its heading, the last of nested ones, and [[#Heading]] in this note', async () => {
    const { prose, project } = await open('[[Orion#Stars]] [[Orion#Stars#Rigel]] [[#Targets]] [[Orion#^abc123]]');
    const all = links(prose);
    await click(all[0]);
    expect(project.open).toHaveBeenLastCalledWith('Guides/Orion.md', 'Stars');
    await click(all[1]);
    expect(project.open).toHaveBeenLastCalledWith('Guides/Orion.md', 'Rigel');
    await click(all[2]);
    expect(project.open).toHaveBeenLastCalledWith(PATH, 'Targets');
    await click(all[3]);
    expect(project.open).toHaveBeenLastCalledWith('Guides/Orion.md', undefined);
  });

  it('draws a link to no note muted, says so, and makes the note on a click', async () => {
    const { prose, project } = await open('See [[Nebula]].');
    const [link] = links(prose);
    expect(link.classList.contains('ws-wikilink-missing')).toBe(true);
    expect(link.title).toBe('No note called Nebula. Click to make it.');
    await click(link);
    expect(project.create).toHaveBeenCalledWith('Nebula', PATH);
    expect(project.open).not.toHaveBeenCalled();
  });

  it('never offers to make a file that isn’t a note from a link', async () => {
    const { prose, project } = await open('See [[Missing.pdf]] and [[Sketch.excalidraw]].');
    const [pdf, canvas] = links(prose);
    for (const link of [pdf, canvas]) expect(link.classList.contains('ws-wikilink-missing')).toBe(true);
    expect(pdf.title).toBe('No file called Missing.pdf.');
    await click(pdf);
    await click(canvas);
    expect(project.create).not.toHaveBeenCalled();
    expect(project.open).not.toHaveBeenCalled();
  });

  it('leaves code spans and fences as written', async () => {
    const { prose } = await open('Write `[[Orion]]` like that.\n\n```\n[[Orion]]\n```\n\nAnd [[Orion]] outside.');
    expect(links(prose)).toHaveLength(1);
    expect(prose.querySelector('code')?.textContent).toBe('[[Orion]]');
    expect(prose.querySelector('pre')?.textContent).toContain('[[Orion]]');
  });

  it('keeps #tags working, and web links opening in a new tab', async () => {
    const { prose } = await open('Plan #october with [[Orion]] and [site](https://example.com).');
    expect(prose.querySelector('.ws-tag-inline')?.textContent).toBe('#october');
    expect(prose.querySelector<HTMLAnchorElement>('a[href="https://example.com"]')?.target).toBe('_blank');
  });

  it('does not nest a link inside a link’s text', async () => {
    const { prose } = await open('[see [[Orion]] now](https://example.com)');
    expect(prose.querySelectorAll('a a')).toHaveLength(0);
    expect(prose.querySelector('a')?.textContent).toBe('see Orion now');
  });

  it('leaves a note read on its own, with no project around it, as plain words', async () => {
    const store = createMemoryFileStore({ [PATH]: 'Notes in [[Orion]].' });
    const view = await render(<NoteView projectId="p" store={store} entry={file(PATH)} kind="note" />);
    mounted.push(view);
    await waitFor(() => expect(view.container.querySelector('.ws-prose')).not.toBeNull());
    expect(view.container.querySelector('.ws-prose')?.textContent).toContain('Notes in Orion.');
  });
});
