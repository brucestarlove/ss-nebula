import type { FileKind } from '../../files/types';
import type { IconName } from './icons';

const DATA_EXTENSIONS = /\.(csv|tsv)$/i;

/** The tree's type mark for a file. */
export function iconForFile(name: string, kind: FileKind): IconName {
  switch (kind) {
    case 'note':
    case 'canvas':
    case 'image':
    case 'pdf':
    case 'audio':
    case 'video':
      return kind;
    case 'text':
      return DATA_EXTENSIONS.test(name) ? 'data' : 'code';
    default:
      return 'file';
  }
}
