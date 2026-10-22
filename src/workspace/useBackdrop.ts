import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileStore } from '../files/types';
import type { ResolvedTheme } from '../nebula/ui/useTheme';
import { applyBackdrop, readBackdrop, sideOf, writeBackdrop, type Backdrop, type BackdropMode, type Side } from './backdrop';
import { BackdropImageError, prepareBackdropImage, type PreparedBackdrop } from './backdropImage';
import { mimeFromName } from './views/shared/mime';

/**
 * The background as Settings shows and changes it, for the theme on screen
 * (src/workspace/backdrop.ts). An uploaded image goes into `store`, the
 * browser tier's `appearance/` folder on this device, under a new name each
 * time; the stored choice points at it, and the image it replaces is
 * deleted. Without a store (tests, the 1.x shell) there are no images.
 */
export type BackdropStatus = 'idle' | 'loading' | 'ready' | 'missing' | 'busy';

export type BackdropControls = {
  side: Side;
  value: Backdrop;
  /** The image on screen, loaded: a blob: URL, or null. */
  imageUrl: string | null;
  status: BackdropStatus;
  /** What went wrong with the last image chosen, in plain words. */
  problem: string | null;
  canUseImages: boolean;
  setMode(mode: BackdropMode): void;
  setColour(colour: string): void;
  setFade(fade: number): void;
  chooseImage(file: File): Promise<void>;
  removeImage(): Promise<void>;
};

type Loaded = { side: Side; name: string; url: string };

function newName(side: Side, ext: string): string {
  return `${side}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.${ext}`;
}

/** Resolves once the image can paint whole, so it never shows half-loaded. */
async function decoded(url: string): Promise<void> {
  if (typeof Image === 'undefined') return;
  const image = new Image();
  image.src = url;
  if (typeof image.decode === 'function') await image.decode().catch(() => {});
}

export function useBackdrop(
  theme: ResolvedTheme,
  store?: FileStore,
  options: { prepare?: (file: File) => Promise<PreparedBackdrop> } = {},
): BackdropControls {
  const side = sideOf(theme);
  const [backdrops, setBackdrops] = useState<Record<Side, Backdrop>>(() => ({ night: readBackdrop('night'), day: readBackdrop('day') }));
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [status, setStatus] = useState<BackdropStatus>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const created = useRef(new Set<string>());
  const { prepare } = options;

  const current = backdrops[side];
  const wanted = store && current.mode === 'image' ? current.image : null;
  const imageUrl = loaded && wanted && loaded.side === side && loaded.name === wanted ? loaded.url : null;

  const update = useCallback((which: Side, patch: Partial<Backdrop>) => {
    const next = writeBackdrop(which, patch);
    setBackdrops((all) => ({ ...all, [which]: next }));
  }, []);

  // Load the image on screen from the store whenever it changes.
  useEffect(() => {
    if (!store || !wanted || (loaded?.side === side && loaded.name === wanted)) return;
    let cancelled = false;
    setStatus('loading');
    void (async () => {
      let blob: Blob;
      try {
        blob = await store.readBlob(wanted);
      } catch {
        if (cancelled) return;
        // Gone (cleared by the browser, or a tab that kept nothing): show
        // the colour, and forget the image so its preview stops painting.
        update(side, { image: null, thumb: null });
        setStatus('missing');
        return;
      }
      const url = URL.createObjectURL(new Blob([blob], { type: mimeFromName(wanted) }));
      await decoded(url);
      if (cancelled) {
        URL.revokeObjectURL(url);
        return;
      }
      // Revocable from here on, once a newer image has replaced it on screen.
      created.current.add(url);
      setLoaded({ side, name: wanted, url });
      setStatus('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, [store, side, wanted, loaded, update]);

  // Paint, then let go of every image no longer kept for showing.
  useEffect(() => {
    applyBackdrop(side, current, imageUrl);
    for (const url of created.current) {
      if (url === loaded?.url) continue;
      URL.revokeObjectURL(url);
      created.current.delete(url);
    }
  }, [side, current, imageUrl, loaded]);

  useEffect(() => {
    const urls = created.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const setMode = useCallback(
    (mode: BackdropMode) => {
      setProblem(null);
      update(side, { mode });
    },
    [side, update],
  );
  const setColour = useCallback((colour: string) => update(side, { colour }), [side, update]);
  const setFade = useCallback((fade: number) => update(side, { fade }), [side, update]);

  const chooseImage = useCallback(
    async (file: File) => {
      if (!store) return;
      const which = side;
      setProblem(null);
      setStatus('busy');
      let prepared: PreparedBackdrop;
      try {
        prepared = await (prepare ?? ((picked: File) => prepareBackdropImage(picked, { fill: backdrops[which].colour })))(file);
      } catch (error) {
        setProblem(error instanceof BackdropImageError ? error.message : 'This browser can’t open that image.');
        setStatus('idle');
        return;
      }
      const name = newName(which, prepared.ext);
      try {
        await store.write(name, prepared.blob);
      } catch {
        setProblem('Couldn’t keep the image in this browser.');
        setStatus('idle');
        return;
      }
      // What is stored now, not this tab's state: another tab may have
      // chosen since, and its file is the one this replaces.
      const before = readBackdrop(which).image;
      const stored = writeBackdrop(which, { mode: 'image', image: name, thumb: prepared.thumb });
      setBackdrops((all) => ({ ...all, [which]: stored }));
      if (stored.image !== name) {
        // localStorage refused the choice (full or blocked): the image in use
        // stays, and the new file goes rather than sit unused.
        await store.remove(name).catch(() => {});
        setProblem('Couldn’t keep the choice in this browser.');
        setStatus(stored.image ? 'ready' : 'idle');
        return;
      }
      if (before && before !== name) await store.remove(before).catch(() => {});
    },
    [store, side, backdrops, prepare],
  );

  const removeImage = useCallback(async () => {
    // What is stored now: another tab may have chosen since.
    const name = readBackdrop(side).image;
    setProblem(null);
    const stored = writeBackdrop(side, { image: null, thumb: null });
    setBackdrops((all) => ({ ...all, [side]: stored }));
    if (name && stored.image === name) {
      // localStorage couldn't forget it, so the file must stay.
      setProblem('Couldn’t change the choice in this browser.');
      return;
    }
    setStatus('idle');
    if (name && store) await store.remove(name).catch(() => {});
  }, [store, side]);

  return {
    side,
    value: current,
    imageUrl,
    status,
    problem,
    canUseImages: store !== undefined,
    setMode,
    setColour,
    setFade,
    chooseImage,
    removeImage,
  };
}
