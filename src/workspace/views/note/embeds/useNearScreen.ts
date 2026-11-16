import { useEffect, useState, type RefObject } from 'react';

/**
 * True once the element has come within `margin` of the screen, and from
 * then on: an embed reads its file only when it is about to be seen (a note
 * with fifty pictures reads the ones you scroll to). Where there is no
 * IntersectionObserver (a test, an old browser) it is true at once.
 */
export function useNearScreen(ref: RefObject<Element | null>, margin = '300px'): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = ref.current;
    if (near || !element) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setNear(true);
        observer.disconnect();
      },
      { rootMargin: margin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, ref, margin]);
  return near;
}
