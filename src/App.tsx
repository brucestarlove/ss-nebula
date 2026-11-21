import { Component, useCallback, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react'
import { bootNebula, type Boot } from './app/boot'
import { askToKeepOnFirstEdit } from './app/keepOnEdit'
import { openTiers } from './app/serverTier'
import { appAsset, appHome, appMount, fileUrl, parseRoute, type OpenTarget } from './app/routes'
import { openBrowserRegistry } from './files/opfsRegistry'
import { requestPersistentStorage } from './files/persist'
import { STANDALONE, type Hosting } from './files/places'
import type { BrowserRegistry } from './files/registry'
import { scopedStore } from './files/scopedStore'
import { Workspace } from './workspace/Workspace'
import { saveBlob } from './workspace/download'

type AppErrorBoundaryState = {
  error: Error | null;
};

class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Nebula failed to render', error, errorInfo);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="nebula-error-state" role="alert">
        <div className="nebula-error-card">
          <p className="nebula-error-eyebrow">Nebula paused before your files opened</p>
          <h1>Something in Nebula failed.</h1>
          <p>
            Nothing was deleted: your files stay in this browser. Reload Nebula, or open DevTools and share this
            error if it repeats.
          </p>
          <pre>{this.state.error.message}</pre>
          <button type="button" className="btn-secondary" onClick={() => window.location.reload()}>
            Reload Nebula
          </button>
        </div>
      </main>
    );
  }
}

/** Throws during render, so a startup failure lands in the error boundary. */
function Fail({ error }: { error: Error }): never {
  throw error
}

function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

type Ready = {
  boot: Boot
  /** The registry the workspace uses: asks the browser to keep files after the first edit. */
  registry: BrowserRegistry
  /** What the address asked to open. */
  initialFile: OpenTarget | null
  /** The homes the page's host offers, and its server. */
  hosting: Hosting
}

/** Where the app is mounted: `/app` on the site, '' at the root (`pnpm dev`,
 * `nebula run`), or where a host put it (`/nebula`). Read once, from the page. */
const APP_BASE = appMount()

// One start per page, whatever React does with effects (StrictMode runs them
// twice in development).
let starting: Promise<Ready> | null = null

function start(): Promise<Ready> {
  starting ??= (async () => {
    const storage = localStorageOrNull()
    const route = parseRoute(window.location, APP_BASE)
    let hosting = STANDALONE
    const boot = await bootNebula({
      storage,
      openRegistry: async () => {
        const tiers = await openTiers(storage, () => openBrowserRegistry())
        hosting = tiers.hosting
        return tiers.handle
      },
      seed: async (registry) => (await import('./files/sample')).seedSampleProject(registry, { baseUrl: appAsset('sample/') }),
    })
    const initialFile: OpenTarget | null = route ? { projectId: route.projectId, path: route.path, context: route.context } : null
    // Asking the browser to keep its storage means nothing when the server keeps the files.
    const registry = boot.persistent && hosting.homes.includes('browser') ? askToKeepOnFirstEdit(boot.registry, requestPersistentStorage) : boot.registry
    return { boot, registry, initialFile, hosting }
  })()
  return starting
}

/** The address follows the open file, so a reload (or a bookmark) returns to it. */
function followInAddress(projectId: string | null, path: string | null) {
  const url = projectId ? fileUrl(projectId, path, APP_BASE) : appHome(APP_BASE)
  if (window.location.pathname + window.location.search + window.location.hash === url) return
  window.history.replaceState(window.history.state, '', url)
}

/** The full address of a file or folder, for Copy link: what an Orbit card
 * holds. It opens wherever this project lives (this browser, this computer). */
function linkTo(projectId: string, path: string | null): string {
  return new URL(fileUrl(projectId, path, APP_BASE), window.location.origin).href
}

// Fade out the boot splash (index.html) once the workspace is ready, but keep
// it up for a minimum of 786ms (measured from navigation start) so a fast load
// doesn't flash the splash in and out.
function hideSplash() {
  const splash = document.getElementById('loader')
  if (!splash) return
  const SPLASH_MIN_MS = 786
  const wait = Math.max(0, SPLASH_MIN_MS - performance.now())
  setTimeout(() => {
    splash.classList.add('is-hiding')
    setTimeout(() => {
      splash.remove()
    }, 400)
  }, wait)
}

function App() {
  const [ready, setReady] = useState<Ready | null>(null)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    let cancelled = false
    start().then(
      (value) => {
        if (!cancelled) setReady(value)
      },
      (reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason : new Error(String(reason)))
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (ready || error) hideSplash()
  }, [ready, error])

  const registry = ready?.registry ?? null
  // This device's own files sit beside the projects, never in one: a
  // background image (src/workspace/useBackdrop.ts).
  const tree = ready?.boot.registry.tree
  const deviceStore = useMemo(() => (tree ? scopedStore(tree, 'appearance') : undefined), [tree])
  const downloadProject = useCallback(
    async (id: string) => {
      if (!registry) return
      const [{ projectToZip, zipFileName }, store, projects] = await Promise.all([import('./files/zip'), registry.files(id), registry.list()])
      const name = projects.find((project) => project.id === id)?.name ?? id
      saveBlob(await projectToZip(store), zipFileName(name))
    },
    [registry],
  )
  return (
    <AppErrorBoundary>
      {error ? <Fail error={error} /> : null}
      {ready ? (
        <Workspace
          registry={ready.registry}
          persistent={ready.boot.persistent}
          intro={ready.boot.intro}
          initialFile={ready.initialFile}
          onActiveFileChange={followInAddress}
          linkTo={linkTo}
          downloadProject={downloadProject}
          deviceStore={deviceStore}
          hosting={ready.hosting}
        />
      ) : null}
    </AppErrorBoundary>
  )
}

export default App
