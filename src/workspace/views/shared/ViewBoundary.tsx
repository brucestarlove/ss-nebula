import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react';
import type { FileViewProps } from '../../../files/types';

// The info card loads only if a view actually crashes.
const OtherView = lazy(() => import('../other/OtherView'));

type BoundaryProps = { view: FileViewProps; children?: ReactNode };
type BoundaryState = { error: unknown };

/** Catches a view that throws while rendering and shows the info card, with
 * the error and Download, instead of a blank tab. */
export class ViewBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: undefined };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error ?? new Error('The view failed') };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Nebula: a file view failed', error, info.componentStack);
  }

  render() {
    if (this.state.error === undefined) return this.props.children;
    return (
      <Suspense fallback={null}>
        <OtherView {...this.props.view} error={this.state.error} />
      </Suspense>
    );
  }
}
