import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { FileViewProps } from '../../../files/types';
import OtherView from '../other/OtherView';
import { formatBytes } from '../shared/format';
import { Glyph } from '../shared/Glyph';
import { ViewLoading } from '../shared/SessionBars';
import { useFileBlob } from '../shared/useFileBlob';
import '../views.css';
import './image.css';
import { fitView, panBy, zoomAt, zoomBy, type Size, type View } from './viewport';

const STEP = 1.25;
const GROUPED = new Intl.NumberFormat('en');

/**
 * An image, fitted to the view; zoom with the buttons, the wheel, a pinch or
 * the keyboard (+, −, 0), pan by dragging. An SVG is only ever an <img>, so
 * its scripts never run, and its URL is revoked once it has been drawn, so
 * "Open image in new tab" can't make it a page of this origin.
 */
export default function ImageView(props: FileViewProps) {
  const { store, entry, onStatus } = props;
  const file = useFileBlob(store, entry.path, entry.name);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const fitted = useRef(true);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const [broken, setBroken] = useState(false);
  const isSvg = file.status === 'ready' && file.blob.type === 'image/svg+xml';

  const boxSize = useCallback((): Size => {
    const stage = stageRef.current;
    return { width: stage?.clientWidth ?? 0, height: stage?.clientHeight ?? 0 };
  }, []);

  const fit = useCallback(() => {
    fitted.current = true;
    setView(fitView(natural ?? { width: 0, height: 0 }, boxSize()));
  }, [natural, boxSize]);

  // Keep fitting while the user hasn't zoomed or panned.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (fitted.current) fit();
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [fit, file.status]);

  useEffect(() => {
    if (file.status !== 'ready') return;
    const bytes = formatBytes(file.blob.size);
    onStatus?.(natural && natural.width > 0 ? `${GROUPED.format(natural.width)} \u00d7 ${GROUPED.format(natural.height)} px \u00b7 ${bytes}` : bytes);
  }, [file, natural, onStatus]);

  const change = useCallback((next: (view: View) => View) => {
    fitted.current = false;
    setView(next);
  }, []);

  // Wheel and trackpad pinch zoom about the pointer. React's wheel listener
  // is passive, so this one is added by hand to stop the page scrolling.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const speed = event.ctrlKey ? 0.01 : 0.0015;
      const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 16 : 1) * speed);
      change((current) => zoomAt(current, factor, { x: event.clientX - rect.left, y: event.clientY - rect.top }));
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [change, file.status]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const known = pointers.current;
    const last = known.get(event.pointerId);
    if (!last) return;
    const point = { x: event.clientX, y: event.clientY };
    if (known.size === 1) {
      change((current) => panBy(current, point.x - last.x, point.y - last.y));
    } else if (known.size === 2) {
      const other = [...known.entries()].find(([id]) => id !== event.pointerId)?.[1];
      const before = other ? Math.hypot(last.x - other.x, last.y - other.y) : 0;
      if (other && before > 0) {
        const after = Math.hypot(point.x - other.x, point.y - other.y);
        const rect = event.currentTarget.getBoundingClientRect();
        const middle = { x: (point.x + other.x) / 2 - rect.left, y: (point.y + other.y) / 2 - rect.top };
        const moved = { x: (point.x - last.x) / 2, y: (point.y - last.y) / 2 };
        change((current) => panBy(zoomAt(current, after / before, middle), moved.x, moved.y));
      }
    }
    known.set(event.pointerId, point);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === '+' || event.key === '=') change((current) => zoomBy(current, STEP, boxSize()));
    else if (event.key === '-' || event.key === '_') change((current) => zoomBy(current, 1 / STEP, boxSize()));
    else if (event.key === '0') fit();
    else return;
    event.preventDefault();
  };

  if (file.status === 'error') return <OtherView {...props} error={file.error} />;
  if (broken) return <OtherView {...props} error={new Error('The browser can\u2019t show this image.')} />;
  if (file.status === 'loading') return <ViewLoading name={entry.name} />;

  return (
    <div className="ws-image">
      <div
        ref={stageRef}
        className="ws-image-stage"
        tabIndex={0}
        role="img"
        aria-label={`${entry.name}. Drag to pan; wheel, pinch or + and \u2212 to zoom; 0 to fit.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
          if (fitted.current) change((current) => zoomAt(current, 1 / current.scale, point));
          else fit();
        }}
        onKeyDown={onKeyDown}
      >
        <img
          className="ws-image-img"
          src={file.url}
          alt=""
          draggable={false}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          onLoad={(event) => {
            const img = event.currentTarget;
            const size = { width: img.naturalWidth, height: img.naturalHeight };
            setNatural(size);
            fitted.current = true;
            setView(fitView(size, boxSize()));
            if (isSvg) URL.revokeObjectURL(file.url);
          }}
          onError={() => setBroken(true)}
        />
      </div>
      <div className="ws-image-tools" role="toolbar" aria-label="Zoom">
        <button type="button" className="ws-view-btn" data-no-arc data-quiet aria-label="Zoom out" onClick={() => change((current) => zoomBy(current, 1 / STEP, boxSize()))}>
          <Glyph name="minus" />
        </button>
        <button
          type="button"
          className="ws-view-btn ws-image-level"
          data-no-arc
          data-quiet
          aria-label="Actual size"
          data-zoom-level
          onClick={() => change((current) => zoomBy(current, 1 / current.scale, boxSize()))}
        >
          {Math.round(view.scale * 100)}%
        </button>
        <button type="button" className="ws-view-btn" data-no-arc data-quiet aria-label="Zoom in" onClick={() => change((current) => zoomBy(current, STEP, boxSize()))}>
          <Glyph name="plus" />
        </button>
        <button type="button" className="ws-view-btn" data-no-arc data-quiet aria-label="Fit to view" onClick={fit}>
          <Glyph name="fit" />
        </button>
      </div>
    </div>
  );
}
