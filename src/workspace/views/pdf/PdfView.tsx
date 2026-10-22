import { useEffect, useState } from 'react';
import type { FileViewProps } from '../../../files/types';
import OtherView from '../other/OtherView';
import { downloadEntry, errorMessage } from '../shared/download';
import { formatBytes } from '../shared/format';
import { Glyph } from '../shared/Glyph';
import { ViewLoading } from '../shared/SessionBars';
import { useFileBlob } from '../shared/useFileBlob';
import '../views.css';
import '../media/media.css';

/** iOS and iPadOS draw only a PDF's first page inside a frame. */
function onlyFirstPage(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** A PDF in the browser's own viewer, from a blob URL typed as a PDF. */
export default function PdfView(props: FileViewProps) {
  const { store, entry, onStatus } = props;
  const file = useFileBlob(store, entry.path, entry.name);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    if (file.status === 'ready') onStatus?.(formatBytes(file.blob.size));
  }, [file, onStatus]);

  if (file.status === 'error') return <OtherView {...props} error={file.error} />;
  if (file.status === 'loading') return <ViewLoading name={entry.name} />;

  return (
    <div className="ws-media ws-pdf">
      <header className="ws-media-head">
        <Glyph name="pdf" />
        <span className="ws-media-name">{entry.name}</span>
        {onlyFirstPage() && <span className="ws-media-hint">Only the first page shows here.</span>}
        <span className="ws-media-actions">
          <a className="ws-view-btn" href={file.url} target="_blank" rel="noopener noreferrer">
            <Glyph name="external" />
            Open in new tab
          </a>
          <button
            type="button"
            className="ws-view-btn"
            data-no-arc
            onClick={() => {
              setDownloadError(null);
              downloadEntry(store, entry).catch((error: unknown) => setDownloadError(errorMessage(error)));
            }}
          >
            <Glyph name="download" />
            Download
          </button>
        </span>
      </header>
      {downloadError && (
        <p className="ws-info-error" role="alert">
          {downloadError}
        </p>
      )}
      <iframe className="ws-pdf-frame" src={file.url} title={entry.name} />
    </div>
  );
}
