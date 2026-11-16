import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry, FileStore } from '../../../../files/types';
import { ProjectLinksContext, type ProjectLinks } from '../../shared/projectLinks';
import { render, settle, waitFor, type Rendered } from '../../testing/render';
import NoteEditor, { type NoteEditorProps } from './NoteEditor';
import { projectLinksOf } from './projectLinks';

const file = (path: string): FileEntry => ({ path, name: path.split('/').at(-1)!, type: 'file', size: 1, modified: 0 });

function editorView(container: HTMLElement): EditorView {
  const dom = container.querySelector<HTMLElement>('.cm-editor');
  if (!dom) throw new Error('no editor yet');
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error('no view');
  return view;
}

describe('NoteEditor', () => {
  const mounted: Rendered[] = [];
  afterEach(async () => {
    for (const view of mounted.splice(0)) await view.unmount();
    document.body.innerHTML = '';
  });

  async function open(props: Partial<NoteEditorProps> = {}, links?: ProjectLinks) {
    const all: NoteEditorProps = {
      value: '# Plan\n\nSaturday.\n',
      revision: 1,
      onChange: () => {},
      fileName: 'Plan.md',
      path: 'Guides/Plan.md',
      label: 'Plan, markdown source',
      ...props,
    };
    const ui = links ? (
      <ProjectLinksContext.Provider value={links}>
        <NoteEditor {...all} />
      </ProjectLinksContext.Provider>
    ) : (
      <NoteEditor {...all} />
    );
    const rendered = await render(ui);
    mounted.push(rendered);
    await waitFor(() => expect(rendered.container.querySelector('.cm-editor')).not.toBeNull());
    return { rendered, all };
  }

  it('shows the note’s Markdown, named for a screen reader, and takes focus', async () => {
    const { rendered } = await open({ autoFocus: true });
    const view = editorView(rendered.container);
    expect(view.state.doc.toString()).toBe('# Plan\n\nSaturday.\n');
    expect(view.contentDOM.getAttribute('aria-label')).toBe('Plan, markdown source');
    expect(view.hasFocus).toBe(true);
    // The live editor, with the note's own type (code.css's note variant).
    const host = rendered.container.querySelector('[data-testid="note-editor"]');
    expect(host?.classList.contains('ws-cm')).toBe(true);
    expect(host?.classList.contains('ws-cm-note')).toBe(true);
    expect(host?.classList.contains('ws-cm-live')).toBe(true);
  });

  it('parses Markdown with GFM (tables, tasks) and code fences by language', async () => {
    const { rendered } = await open({ value: '- [ ] Task\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nlet x = 1\n```\n' });
    const view = editorView(rendered.container);
    const names = new Set<string>();
    syntaxTree(view.state).iterate({ enter: (node) => void names.add(node.name) });
    expect(names).toContain('Task');
    expect(names).toContain('Table');
    expect(names).toContain('FencedCode');
  });

  it('hands every edit to onChange as the whole text', async () => {
    const onChange = vi.fn();
    const { rendered } = await open({ onChange });
    const view = editorView(rendered.container);
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'Clear.' } });
    expect(onChange).toHaveBeenLastCalledWith('# Plan\n\nSaturday.\nClear.');
  });

  it('takes text from disk when the revision changes, and leaves a CRLF copy of the same text alone', async () => {
    const onChange = vi.fn();
    const { rendered, all } = await open({ onChange });
    const view = editorView(rendered.container);
    await rendered.rerender(<NoteEditor {...all} onChange={onChange} value={'# Plan\r\n\r\nSaturday.\r\n'} revision={2} />);
    await settle();
    expect(onChange).not.toHaveBeenCalled();
    await rendered.rerender(<NoteEditor {...all} onChange={onChange} value={'# Plan\n\nSunday.\n'} revision={3} />);
    await settle();
    expect(view.state.doc.toString()).toBe('# Plan\n\nSunday.\n');
    // Typing never comes back through the value: the same revision is ignored.
    await rendered.rerender(<NoteEditor {...all} onChange={onChange} value={'stale'} revision={3} />);
    await settle();
    expect(view.state.doc.toString()).toBe('# Plan\n\nSunday.\n');
  });

  it('is shown, never edited, when read-only', async () => {
    const { rendered } = await open({ readOnly: true });
    const view = editorView(rendered.container);
    expect(view.contentDOM.getAttribute('aria-readonly')).toBe('true');
    expect(view.state.facet(EditorView.editable)).toBe(false);
  });

  it('knows the project’s files and the note’s path, and follows the files without being rebuilt', async () => {
    const open1 = vi.fn();
    const links: ProjectLinks = { files: [file('Guides/Orion.md')], open: open1, create: () => {} };
    const { rendered, all } = await open({}, links);
    const view = editorView(rendered.container);
    expect(projectLinksOf(view.state).files.map((entry) => entry.path)).toEqual(['Guides/Orion.md']);
    expect(projectLinksOf(view.state).path).toBe('Guides/Plan.md');
    projectLinksOf(view.state).open('Guides/Orion.md');
    expect(open1).toHaveBeenCalledWith('Guides/Orion.md');

    const next: ProjectLinks = { files: [file('Guides/Orion.md'), file('Moon phases.md')], open: open1, create: () => {} };
    await rendered.rerender(
      <ProjectLinksContext.Provider value={next}>
        <NoteEditor {...all} />
      </ProjectLinksContext.Provider>,
    );
    await settle();
    expect(editorView(rendered.container)).toBe(view);
    expect(projectLinksOf(view.state).files.map((entry) => entry.path)).toEqual(['Guides/Orion.md', 'Moon phases.md']);
  });

  it('hands its embeds the store and project NoteView gives it', async () => {
    const store = { readText: vi.fn() } as unknown as FileStore;
    const { rendered } = await open({ store, projectId: 'p1' });
    const view = editorView(rendered.container);
    expect(projectLinksOf(view.state).store).toBe(store);
    expect(projectLinksOf(view.state).projectId).toBe('p1');
  });
});
