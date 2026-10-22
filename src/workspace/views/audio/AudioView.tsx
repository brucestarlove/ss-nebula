import type { FileViewProps } from '../../../files/types';
import { MediaView } from '../media/MediaView';

export default function AudioView(props: FileViewProps) {
  return <MediaView {...props} media="audio" />;
}
