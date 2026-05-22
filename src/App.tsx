import { Component, useEffect, useMemo, type ErrorInfo, type ReactNode } from 'react'
import { LazyNebulaExcalidrawShell } from './nebula/LazyNebulaExcalidrawShell'
import { getNebulaOrbitContext } from './nebula/orbitContext'

type AppErrorBoundaryState = {
  error: Error | null;
};

class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Nebula shell failed to render', error, errorInfo);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="nebula-error-state" role="alert">
        <div className="nebula-error-card">
          <p className="nebula-error-eyebrow">Nebula paused before the canvas loaded</p>
          <h1>Something in the local shell failed.</h1>
          <p>
            Your browser-stored canvases are still local data. Reload Nebula, or open DevTools and share
            this error if it repeats.
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

function App() {
  const orbitContext = useMemo(() => getNebulaOrbitContext(), [])

  // Fade out the boot splash (index.html) once the standalone app shell is
  // ready, but keep it up for a minimum of 786ms (measured from navigation
  // start) so a fast load doesn't flash the splash in and out.
  useEffect(() => {
    const splash = document.getElementById('loader')
    if (splash) {
      const SPLASH_MIN_MS = 786
      const wait = Math.max(0, SPLASH_MIN_MS - performance.now())
      setTimeout(() => {
        splash.classList.add('is-hiding')
        setTimeout(() => {
          splash.remove()
        }, 400)
      }, wait)
    }
  }, [])

  return (
    <AppErrorBoundary>
      <LazyNebulaExcalidrawShell context={orbitContext} />
    </AppErrorBoundary>
  )
}

export default App
