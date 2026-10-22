import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { startStarscape } from '@starlove/ui/starscape';
import '../../src/workspace/style';
import { initBackgroundFromStorage } from '../../src/nebula/ui/useBackground';
import { initMotionFromStorage } from '../../src/nebula/ui/useMotion';
import { initThemeFromStorage, resolveStoredTheme } from '../../src/nebula/ui/useTheme';
import { createFakeRegistry, type FakeRegistry } from '../../src/workspace/dev/fakeRegistry';
import { Workspace, initPreferencesFromStorage } from '../../src/workspace';
import { ProbeView } from './shell-probe';

// What main.tsx does before first paint, plus the workspace's preferences.
initThemeFromStorage();
initMotionFromStorage();
initBackgroundFromStorage(resolveStoredTheme());
initPreferencesFromStorage();
startStarscape();

const params = new URLSearchParams(location.search);
const registry = createFakeRegistry({
  projects: Number(params.get('projects') ?? 5),
  empty: params.get('empty') === '1',
  latency: Number(params.get('latency') ?? 0),
});
const intro = params.get('intro');
const downloads: string[] = [];

// What tests reach for: the stores behind the projects, and what was asked of the host.
const shell: { registry: FakeRegistry; downloads: string[]; introDone: number; help: number } = {
  registry,
  downloads,
  introDone: 0,
  help: 0,
};
(window as unknown as { __shell: typeof shell }).__shell = shell;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Workspace
      registry={registry}
      persistent={params.get('persistent') !== '0'}
      intro={intro === 'welcome' || intro === 'migrated' ? intro : null}
      onIntroDone={() => {
        shell.introDone += 1;
      }}
      downloadProject={
        params.get('download') === '0'
          ? undefined
          : async (id) => {
              downloads.push(id);
            }
      }
      viewFor={params.get('view') === 'probe' ? () => ProbeView : undefined}
      onHelp={
        params.get('help') === 'link'
          ? () => {
              shell.help += 1;
            }
          : undefined
      }
    />
  </StrictMode>,
);
