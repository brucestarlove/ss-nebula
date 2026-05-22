import { Component, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LazyNebulaExcalidrawShell } from './LazyNebulaExcalidrawShell';
import type { NebulaContext, NebulaContextInput, NebulaUserContext } from './context';
import type { CanvasSummary, NebulaExcalidrawDocument, SceneStore, SceneStoreRef } from './storage/types';

export type NebulaMountStatus = 'mounted' | 'unmounted';

export type NebulaMountContextInput = NebulaContextInput;

export type NebulaMountLifecycle = {
  /** Called after Nebula's lazy React shell has loaded and committed. */
  onReady?: (handle: NebulaMountHandle) => void;
  /** Called when the public mount wrapper catches a render-time error. */
  onError?: (error: unknown) => void;
  /** Called exactly once when the handle unmounts this root. */
  onUnmount?: () => void;
};

export type MountNebulaOptions = NebulaContextInput & {
  /** Preferred explicit context object for Suite/plugin hosts. Top-level context fields remain supported. */
  context?: NebulaContextInput;
  /** Custom Excalidraw-scene persistence store; defaults to Nebula's localStorage store. */
  store?: SceneStore;
  /** Optional Suspense fallback shown while lazy canvas internals load. */
  fallback?: ReactNode;
  /** Lifecycle callbacks for hosts that need readiness/error/unmount hooks. */
  lifecycle?: NebulaMountLifecycle;
  /** Convenience lifecycle callback alias. */
  onReady?: NebulaMountLifecycle['onReady'];
  /** Convenience lifecycle callback alias. */
  onError?: NebulaMountLifecycle['onError'];
  /** Convenience lifecycle callback alias. */
  onUnmount?: NebulaMountLifecycle['onUnmount'];
  /**
   * Compatibility escape hatch for script-tag style hosts that still read
   * window.__NEBULA_CONTEXT__. React hosts should pass context directly instead.
   */
  exposeContextOnWindow?: boolean;
};

export type NebulaMountHandle = {
  readonly container: HTMLElement;
  /** Resolves after the lazy Nebula shell has loaded and committed; rejects on wrapper render errors. */
  readonly ready: Promise<void>;
  getStatus(): NebulaMountStatus;
  update(options: MountNebulaOptions): void;
  unmount(): void;
};

export type {
  CanvasSummary,
  NebulaContext,
  NebulaExcalidrawDocument,
  NebulaUserContext,
  SceneStore,
  SceneStoreRef,
};

type InternalMountOptions = {
  context: NebulaContextInput;
  store?: SceneStore;
  fallback?: ReactNode;
  lifecycle: NebulaMountLifecycle;
  exposeContextOnWindow: boolean;
};

type NebulaMountErrorBoundaryProps = {
  children: ReactNode;
  onError(error: unknown): void;
};

type NebulaMountErrorBoundaryState = {
  error: unknown;
};

class NebulaMountErrorBoundary extends Component<NebulaMountErrorBoundaryProps, NebulaMountErrorBoundaryState> {
  state: NebulaMountErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): NebulaMountErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError(error);
  }

  render(): ReactNode {
    if (this.state.error) {
      return <div className="nebula-loading">Nebula failed to load.</div>;
    }

    return this.props.children;
  }
}

const CONTEXT_OPTION_KEYS = new Set<keyof NebulaContextInput>([
  'boardId',
  'boardSlug',
  'boardName',
  'canvasId',
  'user',
  'orbitBaseUrl',
]);

function normalizeMountOptions(options: MountNebulaOptions = {}): InternalMountOptions {
  const contextFromTopLevel = Object.fromEntries(
    Object.entries(options).filter(([key]) => CONTEXT_OPTION_KEYS.has(key as keyof NebulaContextInput)),
  ) as NebulaContextInput;

  return {
    context: {
      ...contextFromTopLevel,
      ...options.context,
    },
    store: options.store,
    fallback: options.fallback,
    lifecycle: {
      ...options.lifecycle,
      onReady: options.onReady ?? options.lifecycle?.onReady,
      onError: options.onError ?? options.lifecycle?.onError,
      onUnmount: options.onUnmount ?? options.lifecycle?.onUnmount,
    },
    exposeContextOnWindow: options.exposeContextOnWindow ?? false,
  };
}

function exposeBrowserContext(context: NebulaContextInput): void {
  if (typeof window === 'undefined') return;

  window.__NEBULA_CONTEXT__ = {
    ...window.__NEBULA_CONTEXT__,
    ...context,
  };
}

export function mountNebula(container: HTMLElement, options: MountNebulaOptions = {}): NebulaMountHandle {
  const root: Root = createRoot(container);
  let status: NebulaMountStatus = 'mounted';
  let currentOptions = normalizeMountOptions(options);
  let resolveReady: () => void;
  let rejectReady: (error: unknown) => void;
  let readySettled = false;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const handle: NebulaMountHandle = {
    container,
    ready,
    getStatus: () => status,
    update(nextOptions) {
      if (status === 'unmounted') {
        throw new Error('Cannot update an unmounted Nebula root.');
      }

      currentOptions = normalizeMountOptions(nextOptions);
      renderCurrentOptions();
    },
    unmount() {
      if (status === 'unmounted') return;
      status = 'unmounted';
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error('Nebula mount was unmounted before it became ready.'));
      }
      root.unmount();
      currentOptions.lifecycle.onUnmount?.();
    },
  };

  function markReady(): void {
    if (readySettled || status === 'unmounted') return;
    readySettled = true;
    resolveReady();
    currentOptions.lifecycle.onReady?.(handle);
  }

  function settleError(error: unknown): void {
    currentOptions.lifecycle.onError?.(error);
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
  }

  function renderCurrentOptions(): void {
    try {
      if (currentOptions.exposeContextOnWindow) exposeBrowserContext(currentOptions.context);
      root.render(
        <NebulaMountErrorBoundary onError={settleError}>
          <LazyNebulaExcalidrawShell
            context={currentOptions.context}
            store={currentOptions.store}
            fallback={currentOptions.fallback}
            onReady={markReady}
          />
        </NebulaMountErrorBoundary>,
      );
    } catch (error) {
      settleError(error);
      throw error;
    }
  }

  renderCurrentOptions();

  return handle;
}
