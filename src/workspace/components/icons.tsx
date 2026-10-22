import type { ReactNode } from 'react';

/* The sketch's glyphs: small monochrome strokes on a 16px grid (the gear
 * and help marks are the app's own 24px icons). Inline, so overlays and
 * dialogs need no shared sprite. */
const PATHS = {
  note: (
    <>
      <path d="M4 1.75h5.25L12.5 5v9.25H4z" />
      <path d="M9 1.75V5h3.5" />
      <path d="M6 8.25h4.5M6 10.75h3" />
    </>
  ),
  canvas: (
    <>
      <circle cx="5.9" cy="6" r="3.6" />
      <path d="m8.8 14.25 2.85-5.35 2.85 5.35z" />
    </>
  ),
  image: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.75" />
      <circle cx="6" cy="6.6" r="1.2" />
      <path d="m2.6 12 3.4-3.3 2.4 2.3 1.9-1.8 3.1 2.8" />
    </>
  ),
  pdf: (
    <>
      <path d="M4 1.75h5.25L12.5 5v9.25H4z" />
      <path d="M9 1.75V5h3.5" />
      <rect x="5.6" y="8.3" width="5" height="3.1" rx=".6" />
    </>
  ),
  audio: <path d="M2.75 6.75v2.5M5.4 4.75v6.5M8 2.75v10.5M10.6 5.25v5.5M13.25 6.75v2.5" />,
  video: (
    <>
      <rect x="1.75" y="3.5" width="12.5" height="9" rx="2.25" />
      <path d="M6.75 6.1v3.8L10 8z" />
    </>
  ),
  data: (
    <>
      <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="1.75" />
      <path d="M2.25 6.25h11.5M2.25 9.9h11.5M6.25 2.25v11.5" />
    </>
  ),
  code: (
    <>
      <path d="M4 1.75h5.25L12.5 5v9.25H4z" />
      <path d="M9 1.75V5h3.5" />
      <path d="m6.9 8.1-1.4 1.4 1.4 1.4M9.1 8.1l1.4 1.4-1.4 1.4" />
    </>
  ),
  file: (
    <>
      <path d="M4 1.75h5.25L12.5 5v9.25H4z" />
      <path d="M9 1.75V5h3.5" />
    </>
  ),
  chevron: <path d="m6.25 4 3.75 4-3.75 4" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.25 10.25 3.25 3.25" />
    </>
  ),
  plus: <path d="M8 3.25v9.5M3.25 8h9.5" />,
  'note-plus': (
    <>
      <path d="M8.25 14.25H4V1.75h5.25L12.5 5v3" />
      <path d="M9 1.75V5h3.5" />
      <path d="M12.25 10.25v4.5M10 12.5h4.5" />
    </>
  ),
  'canvas-plus': (
    <>
      <circle cx="5.9" cy="6" r="3.6" />
      <path d="M12 9.5v5M9.5 12h5" />
    </>
  ),
  'folder-plus': (
    <>
      <path d="M8 13.25H1.75v-9h4.1l1.5 1.5h6.9V8" />
      <path d="M12.25 9.75v4.5M10 12h4.5" />
    </>
  ),
  upload: (
    <>
      <path d="M8 10.5V2.75M5 5.75l3-3 3 3" />
      <path d="M2.75 10.25v3h10.5v-3" />
    </>
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05" />
    </>
  ),
  moon: <path d="M13.25 9.6A5.5 5.5 0 0 1 6.4 2.75a5.5 5.5 0 1 0 6.85 6.85z" />,
  panel: (
    <>
      <rect x="1.75" y="2.5" width="12.5" height="11" rx="2" />
      <path d="M10 2.5v11" />
    </>
  ),
  close: <path d="m4.75 4.75 6.5 6.5M11.25 4.75l-6.5 6.5" />,
  menu: <path d="M2.75 4.5h10.5M2.75 8h10.5M2.75 11.5h10.5" />,
  updown: <path d="m5 6.25 3-3 3 3M5 9.75l3 3 3-3" />,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  folder: <path d="M1.75 4.25h4.1l1.5 1.5h6.9v7.5H1.75z" />,
  files: (
    <>
      <path d="M5.5 1.75h4.25l3 3v7.75H5.5z" />
      <path d="M3.25 4.25v10h6.75" />
    </>
  ),
  pencil: (
    <>
      <path d="M10.6 2.6a1.5 1.5 0 0 1 2.1 0l.7.7a1.5 1.5 0 0 1 0 2.1l-7.3 7.3-3.35.55.55-3.35z" />
      <path d="m9.5 3.75 2.75 2.75" />
    </>
  ),
  download: (
    <>
      <path d="M8 2.75v7.5M5 7.5l3 3 3-3" />
      <path d="M2.75 10.75v2.5h10.5v-2.5" />
    </>
  ),
  trash: (
    <>
      <path d="M2.75 4.25h10.5M6.25 4.25v-1.5h3.5v1.5" />
      <path d="m4.25 4.25.65 9h6.2l.65-9" />
    </>
  ),
  browser: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75" />
      <path d="M1.75 5.75h12.5" />
      <path d="M4 4.25h.01M5.75 4.25h.01" />
    </>
  ),
  star: <path d="m8 2.2 1.75 3.6 3.95.55-2.85 2.8.7 3.95L8 11.2l-3.55 1.9.7-3.95-2.85-2.8 3.95-.55z" />,
  open: (
    <>
      <path d="M9.25 2.75h4v4" />
      <path d="M13.25 2.75 7.5 8.5" />
      <path d="M11.75 9.5v3.75h-9v-9H6.5" />
    </>
  ),
  move: (
    <>
      <path d="M1.75 4.25h4.1l1.5 1.5h6.9v7.5H1.75z" />
      <path d="M6 9.5h4.25M8.75 8l1.5 1.5-1.5 1.5" />
    </>
  ),
} satisfies Record<string, ReactNode>;

const PATHS_24 = {
  gear: (
    <>
      <path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS | keyof typeof PATHS_24;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  const big = name in PATHS_24;
  const paths = big ? PATHS_24[name as keyof typeof PATHS_24] : PATHS[name as keyof typeof PATHS];
  return (
    <svg
      className={['g', big ? 'g-24' : '', className ?? ''].filter(Boolean).join(' ')}
      viewBox={big ? '0 0 24 24' : '0 0 16 16'}
      aria-hidden="true"
      focusable="false"
    >
      {paths}
    </svg>
  );
}
