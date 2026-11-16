import type { SVGProps } from 'react';

/** Nebula's small monochrome marks (the sketch's 16px line glyphs). */
const PATHS = {
  note: 'M4 1.75h5.25L12.5 5v9.25H4z M9 1.75V5h3.5 M6 8.25h4.5M6 10.75h3',
  canvas: 'M9.5 6a3.6 3.6 0 1 1-7.2 0 3.6 3.6 0 0 1 7.2 0z m-.7 8.25 2.85-5.35 2.85 5.35z',
  image: 'M3.75 3h8.5A1.75 1.75 0 0 1 14 4.75v6.5A1.75 1.75 0 0 1 12.25 13h-8.5A1.75 1.75 0 0 1 2 11.25v-6.5A1.75 1.75 0 0 1 3.75 3z M7.2 6.6a1.2 1.2 0 1 1-2.4 0 1.2 1.2 0 0 1 2.4 0z m-4.6 5.4 3.4-3.3 2.4 2.3 1.9-1.8 3.1 2.8',
  pdf: 'M4 1.75h5.25L12.5 5v9.25H4z M9 1.75V5h3.5 M6.2 8.3h3.8a.6.6 0 0 1 .6.6v1.9a.6.6 0 0 1-.6.6H6.2a.6.6 0 0 1-.6-.6V8.9a.6.6 0 0 1 .6-.6z',
  audio: 'M2.75 6.75v2.5M5.4 4.75v6.5M8 2.75v10.5M10.6 5.25v5.5M13.25 6.75v2.5',
  video: 'M4 3.5h8A2.25 2.25 0 0 1 14.25 5.75v4.5A2.25 2.25 0 0 1 12 12.5H4A2.25 2.25 0 0 1 1.75 10.25v-4.5A2.25 2.25 0 0 1 4 3.5z M6.75 6.1v3.8L10 8z',
  data: 'M4 2.25h8a1.75 1.75 0 0 1 1.75 1.75v8A1.75 1.75 0 0 1 12 13.75H4A1.75 1.75 0 0 1 2.25 12V4A1.75 1.75 0 0 1 4 2.25z M2.25 6.25h11.5M2.25 9.9h11.5M6.25 2.25v11.5',
  file: 'M4 1.75h5.25L12.5 5v9.25H4z M9 1.75V5h3.5',
  download: 'M8 2.75v7.5M5 7.5l3 3 3-3 M2.75 10.75v2.5h10.5v-2.5',
  external: 'M9.25 2.75h4v4 M13.25 2.75 7.5 8.5 M11.5 9.25v3.5a.75.75 0 0 1-.75.75h-7.5a.75.75 0 0 1-.75-.75v-7.5a.75.75 0 0 1 .75-.75h3.5',
  pencil: 'M10.6 2.6a1.5 1.5 0 0 1 2.1 0l.7.7a1.5 1.5 0 0 1 0 2.1l-7.3 7.3-3.35.55.55-3.35z m-1.1 1.15 2.75 2.75',
  read: 'M1.75 3.25h4a2 2 0 0 1 2 2v8a1.5 1.5 0 0 0-1.5-1.5H1.75z M14.25 3.25h-4a2 2 0 0 0-2 2v8a1.5 1.5 0 0 1 1.5-1.5h4.5z',
  plus: 'M8 3.25v9.5M3.25 8h9.5',
  minus: 'M3.25 8h9.5',
  fit: 'M2.75 6V2.75H6 M10 2.75h3.25V6 M13.25 10v3.25H10 M6 13.25H2.75V10',
  // A note's Markdown source (the source switch): a hash, Markdown's heading mark.
  source: 'M6.4 2.75 5.1 13.25 M10.9 2.75 9.6 13.25 M2.75 6h10.75 M2.5 10h10.75',
  // The page width switch: arrows out to the edges, and back in to the column.
  widen: 'M1.75 8h4.5 M9.75 8h4.5 M3.75 6 1.75 8l2 2 M12.25 6l2 2-2 2 M8 3.25v9.5',
  narrow: 'M1.75 8h4 M10.25 8h4 M3.75 6l2 2-2 2 M12.25 6l-2 2 2 2 M8 3.25v9.5',
} as const;

export type GlyphName = keyof typeof PATHS;

export function Glyph({ name, ...rest }: { name: GlyphName } & SVGProps<SVGSVGElement>) {
  return (
    <svg className="g ws-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false" {...rest}>
      <path d={PATHS[name]} />
    </svg>
  );
}
