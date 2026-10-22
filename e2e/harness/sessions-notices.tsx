/**
 * Round 3 (re-review): the workspace's new notices over the fake registry,
 * to look at. ?case=kept (a change kept beside its file, R1), readonly
 * (a project list from a newer Nebula, R5), migrated (canvases left behind
 * by the move, R3), older (an older tab's saves, R6). Round 4: keptfail (a
 * copy that couldn't be written, offered as a download, F2) and deleted (a
 * change kept after another tab deleted its file, F5).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { startStarscape } from '@starlove/ui/starscape';
import '../../src/workspace/style';
import { initBackgroundFromStorage } from '../../src/nebula/ui/useBackground';
import { initMotionFromStorage } from '../../src/nebula/ui/useMotion';
import { initThemeFromStorage, resolveStoredTheme } from '../../src/nebula/ui/useTheme';
import { Workspace, initPreferencesFromStorage } from '../../src/workspace';
import { createFakeRegistry } from '../../src/workspace/dev/fakeRegistry';
import { reportKeptCopy } from '../../src/workspace/views/shared/fileSessions';

initThemeFromStorage();
initMotionFromStorage();
initBackgroundFromStorage(resolveStoredTheme());
initPreferencesFromStorage();
startStarscape();

const which = new URLSearchParams(location.search).get('case') ?? 'kept';
const registry = createFakeRegistry({ readOnly: which === 'readonly' });
const LIBRARY = 'The Excalidraw library of board ss-nebula didn’t fit in this browser’s storage, so “ss-nebula” starts without it. It’s still saved under the old board.';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Workspace
      registry={registry}
      persistent
      intro={which === 'migrated' ? 'migrated' : null}
      leftBehind={which === 'migrated' ? { canvases: [{ key: 'k1', name: 'Launch plan' }, { key: 'k2', name: 'Winter hexagon, second try' }], warnings: [LIBRARY] } : null}
      onDownloadLeftBehind={() => {}}
      olderTabCanvases={
        which === 'older'
          ? {
              find: async () => [
                { key: 'k1', name: 'Launch plan', updatedAt: '2026-10-21T18:00:00.000Z', projectId: 'pulse' },
                { key: 'k2', name: 'Orion sketch', updatedAt: '2026-10-21T19:00:00.000Z', projectId: null },
              ],
              importCopy: async () => 'Launch plan (older tab).excalidraw.md',
              download: () => {},
            }
          : null
      }
    />
  </StrictMode>,
);

if (which === 'kept') {
  setTimeout(() => reportKeptCopy({ scope: 'night-sky', path: 'Guides/Observing plan.md', copy: 'Guides/Observing plan (conflict 2026-10-22 11.40).md' }), 800);
}
if (which === 'deleted') {
  setTimeout(() => reportKeptCopy({ scope: 'night-sky', path: 'Guides/Observing plan.md', copy: 'Guides/Observing plan (conflict 2026-10-22 11.40).md', deleted: true }), 800);
}
if (which === 'keptfail') {
  const error = Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
  const download = { filename: 'Observing plan (conflict 2026-10-22 11.40).md', text: 'Mine.' };
  setTimeout(() => reportKeptCopy({ scope: 'night-sky', path: 'Guides/Observing plan.md', copy: null, error, download, release: () => {} }), 800);
}
