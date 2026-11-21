/**
 * Round 3 (re-review): the workspace's new notices over the fake registry,
 * to look at. ?case=kept (a change kept beside its file, R1), readonly
 * (a project list from a newer Nebula, R5). Round 4: keptfail (a
 * copy that couldn't be written, offered as a download, F2) and deleted (a
 * change kept after another tab deleted its file, F5).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { startStarscape } from '@starlove/ui/starscape';
import '../../src/workspace/style';
import { initBackdropFromStorage } from '../../src/workspace/backdrop';
import { initMotionFromStorage } from '../../src/nebula/ui/useMotion';
import { initThemeFromStorage, resolveStoredTheme } from '../../src/nebula/ui/useTheme';
import { Workspace, initPreferencesFromStorage } from '../../src/workspace';
import { createFakeRegistry } from '../../src/workspace/dev/fakeRegistry';
import { reportKeptCopy } from '../../src/workspace/views/shared/fileSessions';

initThemeFromStorage();
initMotionFromStorage();
initBackdropFromStorage(resolveStoredTheme());
initPreferencesFromStorage();
startStarscape();

const which = new URLSearchParams(location.search).get('case') ?? 'kept';
const registry = createFakeRegistry({ readOnly: which === 'readonly' });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Workspace registry={registry} persistent />
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
