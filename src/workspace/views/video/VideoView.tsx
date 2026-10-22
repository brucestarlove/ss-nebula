import type { FileViewProps } from '../../../files/types';
import { MediaView } from '../media/MediaView';

export default function VideoView(props: FileViewProps) {
  return <MediaView {...props} media="video" />;
}
