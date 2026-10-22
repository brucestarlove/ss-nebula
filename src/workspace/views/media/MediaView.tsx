import { useEffect, useState } from 'react';
import type { FileViewProps } from '../../../files/types';
import OtherView from '../other/OtherView';
import { formatDuration, titleFromName } from '../shared/format';
import { Glyph } from '../shared/Glyph';
import { ViewLoading } from '../shared/SessionBars';
import { useFileBlob } from '../shared/useFileBlob';
import '../views.css';
import './media.css';

/** Audio and video: the browser's own controls in a Starscape frame. */
export function MediaView({ media, ...props }: FileViewProps & { media: 'audio' | 'video' }) {
  const { store, entry, onStatus } = props;
  const file = useFileBlob(store, entry.path, entry.name);
  const [unplayable, setUnplayable] = useState(false);

  useEffect(() => {
    if (file.status === 'ready') onStatus?.('');
  }, [file.status, onStatus]);

  if (file.status === 'error') return <OtherView {...props} error={file.error} />;
  if (unplayable) return <OtherView {...props} error={new Error(`This browser can\u2019t play this ${media === 'audio' ? 'audio' : 'video'} file.`)} />;
  if (file.status === 'loading') return <ViewLoading name={entry.name} />;

  const onLoadedMetadata = (event: React.SyntheticEvent<HTMLMediaElement>) => {
    onStatus?.(formatDuration(event.currentTarget.duration));
  };

  return (
    <div className={`ws-media ws-media-${media}`}>
      <figure className="ws-media-frame">
        {media === 'video' ? (
          <video className="ws-media-player" src={file.url} controls playsInline preload="metadata" onLoadedMetadata={onLoadedMetadata} onError={() => setUnplayable(true)} />
        ) : (
          <>
            <span className="ws-media-art" aria-hidden="true">
              <Glyph name="audio" />
            </span>
            <audio className="ws-media-player" src={file.url} controls preload="metadata" onLoadedMetadata={onLoadedMetadata} onError={() => setUnplayable(true)} />
          </>
        )}
        <figcaption className="ws-media-caption">{titleFromName(entry.name)}</figcaption>
      </figure>
    </div>
  );
}
