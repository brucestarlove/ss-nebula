import { useEffect, useRef } from 'react';
import { startFrameBridge, type FrameBridge, type NavigateTarget } from '../app/frameBridge';

/** The workspace's side of the frame (src/app/frameBridge.ts): the bridge runs while the workspace
 * does, `ready` goes once the workspace is up, `title` whenever it changes, and the host's
 * `navigate` reaches `navigate`. Nothing happens in a page that isn't framed, except that a tab
 * hidden for a minute lets go of its live feeds. */
export function useFrameBridge({ ready, title, navigate }: { ready: boolean; title: string; navigate: (target: NavigateTarget) => void }): void {
  const bridge = useRef<FrameBridge | null>(null);
  const onNavigate = useRef(navigate);
  onNavigate.current = navigate;
  useEffect(() => {
    const started = startFrameBridge({ onNavigate: (target) => onNavigate.current(target), version: typeof __NEBULA_VERSION__ === 'string' ? __NEBULA_VERSION__ : '' });
    bridge.current = started;
    return () => {
      started.stop();
      bridge.current = null;
    };
  }, []);
  useEffect(() => {
    if (ready) bridge.current?.ready();
  }, [ready]);
  useEffect(() => {
    if (ready) bridge.current?.title(title);
  }, [ready, title]);
}
