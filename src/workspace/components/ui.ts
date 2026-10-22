/** Small helpers shared by the workspace's components. */

/** A stable, valid DOM id for a path or project id. */
export function domId(prefix: string, key: string): string {
  let hash = 5381;
  for (let i = 0; i < key.length; i += 1) hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}

export function tabId(path: string): string {
  return domId('ws-tab', path);
}

export function isApple(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** '⌘K' on Apple devices, 'Ctrl K' elsewhere. */
export function shortcutLabel(key: string): string {
  return isApple() ? `⌘${key}` : `Ctrl ${key}`;
}

/** The platform's command key: ⌘ on Apple devices, Ctrl elsewhere. Either works. */
export function hasMod(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return event.metaKey || event.ctrlKey;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** Keeps a fixed menu inside the viewport, 8px from every edge. */
export function clampToViewport(x: number, y: number, width: number, height: number): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    left: Math.max(8, Math.min(x, vw - width - 8)),
    top: Math.max(8, Math.min(y, vh - height - 8)),
  };
}

export type MenuAt = { x: number; y: number };

/** Where a menu opened from the keyboard appears: just below the element. */
export function menuAtElement(element: Element): MenuAt {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + Math.min(24, rect.width / 2), y: rect.bottom - 4 };
}

/** The keys that open a context menu from the keyboard. */
export function isContextMenuKey(event: { key: string; shiftKey: boolean }): boolean {
  return event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
}
