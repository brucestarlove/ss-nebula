/**
 * Lane C's harness: every file view, mounted the way the workspace will
 * mount it (the sketch's rail, tabs, stage and status line), on an in-memory
 * FileStore with one small fixture per kind.
 *
 * URL: /e2e/harness/views.html?file=<path>&theme=dark|light&style=sheet|pane
 *      &width=fixed|stretch&body=sans|serif
 */
import { startStarscape } from '@starlove/ui/starscape';
import '@starlove/ui/templates/sidebar';
import { StrictMode, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../e2e/assets/fonts/fonts.css';
import '../../e2e/assets/sketch.css';
import { kindFromName } from '../../src/files/kinds';
import type { FileEntry, FileKind } from '../../src/files/types';
import { isObsidianExcalidrawMarkdown, readObsidianExcalidrawMarkdown } from '../../src/nebula/excalidraw/obsidianMarkdown';
import '../../src/nebula/style';
import { viewFor } from '../../src/workspace/views';
import { buildFixtures, NOTE_PATH } from './views-fixtures';
import { createMemoryFileStore, type MemoryFileStore } from './views-store';

const params = new URLSearchParams(location.search);
const root = document.documentElement;
const night = params.get('theme') !== 'light';
root.dataset.theme = night ? 'dark' : 'light';
root.dataset.bg = night ? 'starfield' : 'parchment';
root.dataset.motion = 'reduce';
root.dataset.style = params.get('style') === 'pane' ? 'pane' : 'sheet';
root.dataset.width = params.get('width') === 'stretch' ? 'stretch' : 'fixed';
root.dataset.body = params.get('body') === 'serif' ? 'serif' : 'sans';
root.dataset.projects = '1';

type HarnessApi = {
  store: MemoryFileStore;
  open(path: string): void;
  peek(path: string): string | undefined;
  read(path: string): Promise<string>;
  writeElsewhere(path: string, text: string): Promise<void>;
  sceneElements(path: string): Promise<Array<{ id: string; type: string; isDeleted?: boolean }>>;
  files(): Promise<FileEntry[]>;
};

declare global {
  interface Window {
    __views?: HarnessApi;
    __viewsReady?: boolean;
  }
}

async function kindOf(store: MemoryFileStore, entry: FileEntry): Promise<FileKind> {
  const kind = kindFromName(entry.name);
  if (kind !== 'note') return kind;
  // Lane A's content check: a plain .md can be an Obsidian Excalidraw drawing.
  try {
    return isObsidianExcalidrawMarkdown(await store.readText(entry.path)) ? 'canvas' : 'note';
  } catch {
    return 'note';
  }
}

export function Harness({ store, initial }: { store: MemoryFileStore; initial: string }) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [path, setPath] = useState(initial);
  const [kind, setKind] = useState<FileKind | null>(null);
  const [status, setStatus] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const refresh = () => void store.list().then((entries) => setFiles(entries.filter((entry) => entry.type === 'file')));
    refresh();
    return store.watch(refresh);
  }, [store]);

  const entry = useMemo(() => files.find((file) => file.path === path), [files, path]);

  useEffect(() => {
    let cancelled = false;
    setKind(null);
    setStatus('');
    setDirty(false);
    if (entry) void kindOf(store, entry).then((next) => !cancelled && setKind(next));
    return () => {
      cancelled = true;
    };
    // The entry object changes on every write; the kind only depends on the path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, entry?.path]);

  const open = useCallback((next: string) => {
    setPath(next);
    const url = new URL(location.href);
    url.searchParams.set('file', next);
    history.replaceState(null, '', url);
  }, []);

  useEffect(() => {
    if (window.__views) window.__views.open = open;
  }, [open]);

  const View = kind ? viewFor(kind) : null;
  const title = entry?.name ?? path;

  return (
    <div className="ws page-sidebar-app" id="ws">
      <aside className="page-sidebar ws-rail" aria-label="Project">
        <div className="page-sidebar-header ws-switcher">
          <img className="ws-switcher-logo" src="/e2e/assets/images/nebula-logo.png" alt="" width="32" height="28" />
          <span className="page-sidebar-titles">
            <span className="page-sidebar-title">Night Sky</span>
            <span className="page-sidebar-subtitle">Views harness · in memory</span>
          </span>
        </div>
        <nav className="page-sidebar-nav ws-tree" aria-label="Files">
          <div className="page-sidebar-section">
            <div className="page-sidebar-section-label">Files</div>
            {files.map((file) => (
              <a
                key={file.path}
                className="page-sidebar-nav-item"
                href={`?file=${encodeURIComponent(file.path)}`}
                data-active={file.path === path ? '' : undefined}
                data-path={file.path}
                onClick={(event) => {
                  event.preventDefault();
                  open(file.path);
                }}
              >
                <span className="page-sidebar-nav-label">{file.path}</span>
              </a>
            ))}
          </div>
        </nav>
      </aside>

      <main className="page-sidebar-main ws-main">
        <header className="ws-phone-top">
          <span className="ws-phone-title">
            <span data-title>{title}</span>
          </span>
        </header>
        <header className="ws-tabs" role="tablist" aria-label="Open files">
          <button className="ws-tab" type="button" role="tab" aria-selected="true">
            <span className="ws-tab-name">{title}</span>
            {dirty && <span aria-label="Unsaved changes"> ●</span>}
          </button>
        </header>
        <div className="ws-body">
          <section className="ws-stage" data-kind={kind ?? ''} data-path={path}>
            {entry && View && kind && (
              <Suspense fallback={<div className="ws-view-state">Loading the {kind} view…</div>}>
                <View
                  key={path}
                  projectId="harness-project"
                  store={store}
                  entry={entry}
                  kind={kind}
                  onStatus={setStatus}
                  onDirty={setDirty}
                />
              </Suspense>
            )}
          </section>
        </div>
        <footer className="ws-status">
          <span className="ws-store-dot" aria-hidden="true" />
          <span data-testid="saved">{dirty ? 'Unsaved changes' : 'Saved in memory'}</span>
          <span aria-hidden="true">·</span>
          <span data-testid="status">{status}</span>
          <span className="ws-sign">
            <b>Nebula</b>
            <em>a Starscape app</em>
          </span>
        </footer>
      </main>
    </div>
  );
}

async function main() {
  startStarscape();
  const store = createMemoryFileStore(await buildFixtures());
  store.unreadable.add('Broken/unreadable.md');
  window.__views = {
    store,
    open: () => undefined,
    peek: (path) => store.peek(path),
    read: (path) => store.readText(path),
    writeElsewhere: (path, text) => store.write(path, text),
    async sceneElements(path) {
      const text = await store.readText(path);
      if (!text.trim()) return [];
      const scene = path.endsWith('.excalidraw') ? JSON.parse(text) : readObsidianExcalidrawMarkdown(text);
      return scene.elements;
    },
    files: () => store.list(),
  };
  const initial = params.get('file') ?? NOTE_PATH;
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Harness store={store} initial={initial} />
    </StrictMode>,
  );
  window.__viewsReady = true;
}

void main();
