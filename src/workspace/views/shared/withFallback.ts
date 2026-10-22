import { createElement, type ComponentType } from 'react';
import type { FileViewProps } from '../../../files/types';
import { ViewBoundary } from './ViewBoundary';

/** Wraps a view in a ViewBoundary that resets when another file opens. */
export function withFallback(View: ComponentType<FileViewProps>): ComponentType<FileViewProps> {
  function GuardedView(props: FileViewProps) {
    return createElement(ViewBoundary, { key: props.entry.path, view: props }, createElement(View, props));
  }
  GuardedView.displayName = `Guarded(${View.displayName ?? View.name ?? 'View'})`;
  return GuardedView;
}
