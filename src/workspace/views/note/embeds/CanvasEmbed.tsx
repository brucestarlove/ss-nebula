import { useContext, useEffect, useRef, useState } from 'react';
import type { FileEntry } from '../../../../files/types';
import { titleFromName } from '../../shared/format';
import { useProjectLinks } from '../../shared/projectLinks';
import { boxKey, frameStyle, knownBox, rememberBox, type Box, type EmbedSize } from './embedBoxes';
import { NoteEnvContext } from './NoteEnv';
import { FileLink } from './WikiLink';
import { useDocumentTheme } from './useDocumentTheme';
import { useNearScreen } from './useNearScreen';

type Preview = { status: 'idle' | 'loading' | 'failed' } | { status: 'ready'; url: string };

/** The drawing's file, read when it comes near the screen, and the size of its picture, told from its elements alone. */
type Source = { status: 'idle' | 'failed' } | { status: 'ready'; text: string; box?: Box };

function useCanvasSource(file: FileEntry, wanted: boolean, key: string): Source {
  const env = useContext(NoteEnvContext);
  const [source, setSource] = useState<Source>({ status: 'idle' });
  const store = env?.store;
  useEffect(() => {
    if (!wanted || !store) return undefined;
    let cancelled = false;
    store.readText(file.path).then(
      (text) => {
        if (cancelled) return;
        setSource({ status: 'ready', text });
        // The size comes before Excalidraw does (it is fetched for the picture below), so the place is kept
        // while the library loads. A file that isn't a drawing is told by the picture's own failure.
        void import('./canvasScene')
          .then(({ sceneBox }) => sceneBox(text, file.path))
          .then(
            (box) => {
              if (!box || cancelled) return;
              rememberBox(key, box);
              setSource({ status: 'ready', text, box });
            },
            () => undefined,
          );
      },
      (error: unknown) => {
        if (cancelled) return;
        console.warn('Nebula couldn’t read an embedded canvas', file.path, error);
        setSource({ status: 'failed' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [wanted, store, file.path, file.size, file.modified, key]);
  return source;
}

/**
 * The drawing as an image URL. Excalidraw is fetched here, on the first
 * embed that comes near the screen, never with the note; the picture is SVG
 * text in a blob, so nothing in it can run, and it is drawn again when the
 * file or the theme changes.
 */
function useCanvasPreview(file: FileEntry, text: string | null): Preview {
  const env = useContext(NoteEnvContext);
  const theme = useDocumentTheme();
  const [preview, setPreview] = useState<Preview>({ status: 'idle' });
  const store = env?.store;
  useEffect(() => {
    if (text === null || !store) return undefined;
    let cancelled = false;
    let url: string | null = null;
    import('./canvasSvg')
      .then(({ renderCanvasSvg }) => renderCanvasSvg(store, file.path, theme, text))
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
  }, [text, store, file.path, theme]);
  return preview;
}

/**
 * `![[Sketch.excalidraw]]`: a picture of the drawing; a click opens the canvas. If it can't be drawn, its name is a link and the note carries on.
 * The drawing keeps its place before it is drawn: the size asked for (`|300`, `|300x200`), else the
 * picture's own proportions, read from the file's elements (sceneBox), so nothing below it moves.
 */
export function CanvasEmbed({ file, size = null }: { file: FileEntry; size?: EmbedSize }) {
  const project = useProjectLinks();
  const env = useContext(NoteEnvContext);
  const ref = useRef<HTMLSpanElement>(null);
  const near = useNearScreen(ref, '200px');
  const key = boxKey(env?.projectId ?? '', file);
  const source = useCanvasSource(file, near, key);
  const preview = useCanvasPreview(file, source.status === 'ready' ? source.text : null);
  const name = titleFromName(file.name);
  if (preview.status === 'failed' || source.status === 'failed') return <FileLink file={file} label={name} className="ws-embed-canvas-failed" />;
  const box = knownBox(key) ?? (source.status === 'ready' ? source.box : undefined);
  const frame = frameStyle(size, box);
  return (
    <span className="ws-embed-canvas-slot" ref={ref}>
      <button type="button" className="ws-embed-canvas" data-no-arc aria-label={`Open ${name}`} title={`Open ${name}`} onClick={() => project.open(file.path)}>
        <span className="ws-embed-canvas-frame" style={frame} data-reserved={frame ? '' : undefined}>
          {preview.status === 'ready' ? <img src={preview.url} alt={name} decoding="async" /> : <span className="ws-embed-canvas-wait">{name}</span>}
        </span>
      </button>
    </span>
  );
}
