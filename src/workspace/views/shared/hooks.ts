import { useEffect, useState } from 'react';

/** The time, refreshed every `intervalMs`, for "Edited 4 min ago". */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** True on Apple platforms, where the editor shortcut is ⌘ rather than Ctrl. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform) || /Mac OS X|iPhone|iPad/.test(navigator.userAgent);
}

/** Whether a keydown is Mod+<key>: ⌘ on Apple platforms, Ctrl elsewhere. */
export function isModKey(event: KeyboardEvent, key: string, apple = isApplePlatform()): boolean {
  if (event.altKey || event.shiftKey || event.key.toLowerCase() !== key) return false;
  return apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** Whether an element is on screen: views kept alive in hidden tabs ignore shortcuts. */
export function isShown(element: Element | null): boolean {
  return Boolean(element?.isConnected && element.getClientRects().length > 0);
}
