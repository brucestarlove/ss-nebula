/**
 * Night Sky, the sample project brand-new visitors get (docs/slice-3.md,
 * decision 5). Its notes and canvas travel in this module as text; the image
 * and the PDF are fetched from public/sample/ when the project is made, so the
 * binaries never enter the JavaScript bundle. public/sample/CREDITS.md says
 * where each file comes from.
 */
import observingPlan from './sample/Observing plan.md?raw';
import moonPhases from './sample/Moon phases.md?raw';
import orion from './sample/Orion.md?raw';
import readme from './sample/README.md?raw';
import winterHexagon from './sample/Winter hexagon.excalidraw.md?raw';
import type { BrowserRegistry } from './registry';
import type { ProjectRecord, WorkspaceState } from './types';
import { writeWorkspaceState } from './workspaceState';

export const SAMPLE_PROJECT = { name: 'Night Sky', color: '#7c8cff' } as const;

export type SampleOptions = {
  fetch?: typeof fetch;
  /** Where public/sample/ is served. Default '/sample/'. */
  baseUrl?: string;
};

export type SampleResult = {
  project: ProjectRecord;
  /** Files that couldn't be fetched, so aren't in the project. */
  missing: string[];
};

const TEXT_FILES: Array<[path: string, text: string]> = [
  ['README.md', readme],
  ['Guides/Observing plan.md', observingPlan],
  ['Guides/Orion.md', orion],
  ['Guides/Moon phases.md', moonPhases],
  ['Sketches/Winter hexagon.excalidraw.md', winterHexagon],
];

const FETCHED_FILES: Array<[path: string, asset: string]> = [
  ['Photos/Winter hexagon.png', 'winter-hexagon.png'],
  ['Charts/Star chart — October.pdf', 'star-chart.pdf'],
];

const WORKSPACE: WorkspaceState = {
  tabs: ['Guides/Observing plan.md', 'Sketches/Winter hexagon.excalidraw.md', 'Photos/Winter hexagon.png'],
  active: 'Guides/Observing plan.md',
  expanded: ['Guides', 'Sketches', 'Photos'],
  starred: ['Guides/Observing plan.md', 'Sketches/Winter hexagon.excalidraw.md'],
};

async function fetchBlob(fetcher: typeof fetch, url: string): Promise<Blob | null> {
  try {
    const response = await fetcher(url);
    return response.ok ? await response.blob() : null;
  } catch {
    return null;
  }
}

/** Makes the Night Sky project and fills it. Opens nothing: the caller does. */
export async function seedSampleProject(registry: BrowserRegistry, options: SampleOptions = {}): Promise<SampleResult> {
  const fetcher = options.fetch ?? fetch.bind(globalThis);
  const baseUrl = options.baseUrl ?? '/sample/';
  const project = await registry.create({ ...SAMPLE_PROJECT });
  const store = await registry.files(project.id);

  for (const [path, text] of TEXT_FILES) await store.write(path, text);
  const blobs = await Promise.all(FETCHED_FILES.map(([, asset]) => fetchBlob(fetcher, `${baseUrl}${asset}`)));
  const missing: string[] = [];
  for (const [index, [path]] of FETCHED_FILES.entries()) {
    const blob = blobs[index];
    if (blob) await store.write(path, blob);
    else missing.push(path);
  }

  // Open what's there: a file that couldn't be fetched leaves no tab, and its
  // folder, if empty, isn't there to expand.
  const written = [...TEXT_FILES, ...FETCHED_FILES].map(([path]) => path).filter((path) => !missing.includes(path));
  await writeWorkspaceState(store, {
    tabs: WORKSPACE.tabs.filter((path) => written.includes(path)),
    active: WORKSPACE.active,
    expanded: WORKSPACE.expanded.filter((folder) => written.some((path) => path.startsWith(`${folder}/`))),
    starred: WORKSPACE.starred.filter((path) => written.includes(path)),
  });
  return { project, missing };
}
