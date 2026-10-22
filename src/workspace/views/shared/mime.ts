/** MIME types for the bytes Nebula hands to the browser. The type always comes
 * from the file name, never from the store: a `.pdf` that holds HTML must
 * still reach the PDF viewer as a PDF, and nothing a view opens may become a
 * page of this origin. Anything unlisted is opaque bytes. */
const BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
};

export const OPAQUE_TYPE = 'application/octet-stream';

export function mimeFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return OPAQUE_TYPE;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? OPAQUE_TYPE;
}

/** The same bytes, typed by the file name (or by `type`, for downloads). */
export function typedBlob(blob: Blob, name: string, type: string = mimeFromName(name)): Blob {
  return blob.type === type ? blob : new Blob([blob], { type });
}
