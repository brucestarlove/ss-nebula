import { useContext, useEffect, useRef, useState } from 'react';
import type { FileEntry } from '../../../../files/types';
import { titleFromName } from '../../shared/format';
import { useProjectLinks } from '../../shared/projectLinks';
import { NoteEnvContext } from './NoteEnv';
import { FileLink } from './WikiLink';
import { useDocumentTheme } from './useDocumentTheme';
import { useNearScreen } from './useNearScreen';

type Preview = { status: 'idle' | 'loading' | 'failed' } | { status: 'ready'; url: string };

/**
 * The drawing as an image URL. Excalidraw is fetched here, on the first
 * embed that comes near the screen, never with the note; the picture is SVG
 * text in a blob, so nothing in it can run, and it is drawn again when the
 * file or the theme changes.
 */
function useCanvasPreview(file: FileEntry, wanted: boolean): Preview {
  const env = useContext(NoteEnvContext);
  const theme = useDocumentTheme();
  const [preview, setPreview] = useState<Preview>({ status: 'idle' });
  const store = env?.store;
  useEffect(() => {
    if (!wanted || !store) return undefined;
    let cancelled = false;
    let url: string | null = null;
    import('./canvasSvg')
      .then(({ renderCanvasSvg }) => renderCanvasSvg(store, file.path, theme))
      .then(
        (blob) => {
          if (cancelled) return;
          if (!blob) {
            setPreview({ status: 'failed' });
            return;
          }
          url = URL.createObjectURL(blob);
          setPreview({ status: 'ready', url });
        },
        (error: unknown) => {
          if (cancelled) return;
          console.warn('Nebula couldn’t draw an embedded canvas', file.path, error);
          setPreview({ status: 'failed' });
        },
      );
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [wanted, store, file.path, file.size, file.modified, theme]);
  return preview;
}

/** `![[Sketch.excalidraw]]`: a picture of the drawing; a click opens the canvas. If it can't be drawn, its name is a link and the note carries on. */
export function CanvasEmbed({ file }: { file: FileEntry }) {
  const project = useProjectLinks();
  const ref = useRef<HTMLSpanElement>(null);
  const near = useNearScreen(ref, '200px');
  const preview = useCanvasPreview(file, near);
  const name = titleFromName(file.name);
  if (preview.status === 'failed') return <FileLink file={file} label={name} className="ws-embed-canvas-failed" />;
  return (
    <span className="ws-embed-canvas-slot" ref={ref}>
      <button type="button" className="ws-embed-canvas" data-no-arc aria-label={`Open ${name}`} title={`Open ${name}`} onClick={() => project.open(file.path)}>
        {preview.status === 'ready' ? <img src={preview.url} alt={name} decoding="async" /> : <span className="ws-embed-canvas-wait">{name}</span>}
      </button>
    </span>
  );
}
