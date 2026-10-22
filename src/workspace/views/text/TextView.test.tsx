import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createMemoryFileStore, type MemoryFileStore } from '../../../../e2e/harness/views-store';
import type { FileEntry } from '../../../files/types';
import type { CodeEditorProps } from '../code/CodeEditor';
import { render, waitFor } from '../testing/render';
import TextView from './TextView';

// CodeMirror needs a real layout engine; Playwright drives the real editor
// (e2e/views-*.spec.ts). Here a textarea stands in, with the same props.
vi.mock('../code/CodeEditor', async () => {
  const { useEffect } = await import('react');
  return {
    default: function FakeEditor({ value, onChange, label, onLanguage, fileName, readOnly }: CodeEditorProps) {
      useEffect(() => onLanguage?.(fileName.endsWith('.ts') ? 'TypeScript' : null), [fileName, onLanguage]);
      return <textarea aria-label={label} value={value} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} />;
    },
  };
});

const PATH = 'src/sky.ts';
const entry: FileEntry = { path: PATH, name: 'sky.ts', type: 'file', size: 60, modified: 0 };
const SOURCE = 'export const DARK = 20 * 60;\n\nexport function dark(sun: number) {\n  return sun < -18;\n}\n';

function type(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('TextView', () => {
  let store: MemoryFileStore;

  beforeEach(() => {
    store = createMemoryFileStore({ [PATH]: SOURCE });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('shows the file with its language and reports its line count', async () => {
    const onStatus = vi.fn();
    const view = await render(<TextView projectId="p" store={store} entry={entry} kind="text" onStatus={onStatus} />);
    await waitFor(() => expect(view.container.querySelector('textarea')).not.toBeNull());
    expect(view.container.querySelector('textarea')?.value).toBe(SOURCE);
    expect(view.container.querySelector('.ws-code-head')?.textContent).toContain('sky.ts');
    expect(view.container.querySelector('.ws-code-head')?.textContent).toContain('TypeScript');
    await waitFor(() => expect(onStatus).toHaveBeenLastCalledWith('5 lines'));
    await view.unmount();
  });

  it('saves 500 ms after typing stops, and says it is dirty until then', async () => {
    const onDirty = vi.fn();
    const view = await render(<TextView projectId="p" store={store} entry={entry} kind="text" onDirty={onDirty} />);
    await waitFor(() => expect(view.container.querySelector('textarea')).not.toBeNull());

    vi.useFakeTimers();
    await act(async () => type(view.container.querySelector('textarea')!, `${SOURCE}// more\n`));
    expect(onDirty).toHaveBeenLastCalledWith(true);
    expect(store.writes).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(store.peek(PATH)).toBe(`${SOURCE}// more\n`);
    expect(onDirty).toHaveBeenLastCalledWith(false);
    vi.useRealTimers();
    await view.unmount();
  });

  it('shows a file that isn’t UTF-8 read-only, with Download, and never saves it', async () => {
    // 'café' in Latin-1.
    store = createMemoryFileStore({ [PATH]: new Blob([new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a])]) });
    const view = await render(<TextView projectId="p" store={store} entry={entry} kind="text" />);
    await waitFor(() => expect(view.container.querySelector('textarea')).not.toBeNull());
    expect(view.container.querySelector('textarea')?.readOnly).toBe(true);
    const bar = view.container.querySelector('.ws-conflict');
    expect(bar?.textContent).toContain('isn’t UTF-8');
    expect([...(bar?.querySelectorAll('button') ?? [])].map((button) => button.textContent?.trim())).toEqual(['Download']);
    await view.unmount();
    expect(store.writes).toHaveLength(0);
  });

  it('falls back to the info card when the file cannot be read', async () => {
    store.unreadable.add(PATH);
    const view = await render(<TextView projectId="p" store={store} entry={entry} kind="text" />);
    await waitFor(() => expect(view.container.querySelector('.ws-info-card')).not.toBeNull());
    await view.unmount();
  });
});
