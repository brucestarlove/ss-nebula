import { useEffect, useState } from 'react';
import type { FileEntry, FileKind, FileViewProps } from '../../../files/types';
import { downloadEntry, errorMessage } from '../shared/download';
import { formatBytes, formatDateTime, kindLabel } from '../shared/format';
import { Glyph, type GlyphName } from '../shared/Glyph';
import '../views.css';

export type OtherViewProps = FileViewProps & {
  error?: unknown;
  /** Another way to open the file, offered beside Download. */
  alternative?: { label: string; onOpen(): void };
};

const GLYPH_BY_KIND: Record<FileKind, GlyphName> = {
  note: 'note',
  canvas: 'canvas',
  image: 'image',
  pdf: 'pdf',
  audio: 'audio',
  video: 'video',
  text: 'data',
  other: 'file',
};

/** The info card: name, kind, size, modified, Download. Every other view falls
 * back to it when it can't read its file. */
export default function OtherView({ store, entry, kind, onStatus, error, alternative }: OtherViewProps) {
  const [details, setDetails] = useState<FileEntry>(entry);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    setDetails(entry);
    if (entry.size !== undefined && entry.modified !== undefined) return undefined;
    let cancelled = false;
    store
      .stat(entry.path)
      .then((stat) => {
        if (!cancelled && stat) setDetails((current) => ({ ...current, ...stat }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [store, entry]);

  useEffect(() => {
    onStatus?.(formatBytes(details.size));
  }, [onStatus, details.size]);

  const download = () => {
    setDownloadError(null);
    downloadEntry(store, details).catch((reason: unknown) => setDownloadError(errorMessage(reason)));
  };

  const size = formatBytes(details.size);
  const modified = formatDateTime(details.modified);

  return (
    <div className="ws-info">
      <section className="ws-info-card" aria-label={`About ${details.name}`}>
        <span className="ws-info-mark">
          <Glyph name={GLYPH_BY_KIND[kind] ?? 'file'} />
        </span>
        <h2>{details.name}</h2>
        <dl className="ws-info-facts">
          <div>
            <dt>Kind</dt>
            <dd>{kindLabel(details.name)}</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>{size || '—'}</dd>
          </div>
          <div>
            <dt>Modified</dt>
            <dd>{modified || '—'}</dd>
          </div>
        </dl>
        {error !== undefined && (
          <p className="ws-info-error" role="alert">
            Nebula couldn&rsquo;t open this file. {errorMessage(error)}
          </p>
        )}
        {downloadError && (
          <p className="ws-info-error" role="alert">
            Couldn&rsquo;t download it. {downloadError}
          </p>
        )}
        <div className="ws-info-actions">
          {alternative ? (
            <button type="button" className="ws-btn ws-view-btn" data-no-arc onClick={alternative.onOpen}>
              <Glyph name={alternative.label === 'Open as note' ? 'note' : 'data'} />
              {alternative.label}
            </button>
          ) : null}
          <button type="button" className="ws-btn ws-view-btn" data-no-arc onClick={download}>
            <Glyph name="download" />
            Download
          </button>
        </div>
      </section>
    </div>
  );
}
