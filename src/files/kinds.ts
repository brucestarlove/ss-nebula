import type { FileKind, FileStore } from './types';

const BY_EXTENSION: Record<string, FileKind> = {
  md: 'note',
  markdown: 'note',
  excalidraw: 'canvas',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  svg: 'image',
  pdf: 'pdf',
  mp3: 'audio',
  m4a: 'audio',
  wav: 'audio',
  ogg: 'audio',
  oga: 'audio',
  flac: 'audio',
  aac: 'audio',
  opus: 'audio',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  m4v: 'video',
  ogv: 'video',
};

// Text and code. `.canvas` is Obsidian's JSON Canvas: shown as text until it
// gets a view of its own (PLAN §5.4).
const TEXT_EXTENSIONS = new Set(
  (
    'txt text log csv tsv json jsonc json5 yaml yml toml ini cfg conf env xml canvas ' +
    'js mjs cjs jsx ts mts cts tsx css scss sass less html htm vue svelte astro ' +
    'py rb go rs java kt kts swift c h cc cpp hpp cs php lua pl r sql sh bash zsh fish ps1 ' +
    'dart scala clj ex exs erl hs elm nim zig gradle dockerfile graphql gql proto tex bib diff patch'
  ).split(' '),
);

const TEXT_NAMES = new Set([
  'readme',
  'license',
  'licence',
  'copying',
  'notice',
  'authors',
  'changelog',
  'makefile',
  'dockerfile',
  'procfile',
  'gemfile',
  'rakefile',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.npmrc',
  '.nvmrc',
  '.env',
]);

/** What a file opens as, judged by its name alone. A plain `.md` may still be
 * an Obsidian Excalidraw drawing: the content check comes after this. */
export function kindFromName(name: string): FileKind {
  const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase();
  if (base.endsWith('.excalidraw.md')) return 'canvas';
  if (TEXT_NAMES.has(base)) return 'text';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return 'other';
  const extension = base.slice(dot + 1);
  return BY_EXTENSION[extension] ?? (TEXT_EXTENSIONS.has(extension) ? 'text' : 'other');
}

// The same test as isObsidianExcalidrawFile() (src/nebula/excalidraw/
// obsidianMarkdown.ts), which reads and writes canvases (decision 1): the
// `excalidraw-plugin` key, with a value, in the leading frontmatter block, as
// Obsidian itself decides. A note that quotes a drawing or mentions the key
// stays a note (review finding 8). It is repeated here because the build puts
// that module in the canvas chunk, which the file tree mustn't load;
// kinds.test.ts checks the two agree.
const LEADING_FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n((?:[^\n]*\n)*?)(?:---|\.\.\.)[ \t]*\r?(?:\n|$)/;
const PLUGIN_KEY_RE = /^["']?excalidraw-plugin["']?[ \t]*:[ \t]*(.*?)[ \t]*\r?$/m;
const FALSY_YAML = new Set(['', 'false', 'null', '~', '0']);

function isExcalidrawMarkdown(text: string): boolean {
  const frontmatter = LEADING_FRONTMATTER_RE.exec(text)?.[1];
  if (frontmatter === undefined) return false;
  const raw = PLUGIN_KEY_RE.exec(frontmatter)?.[1];
  if (raw === undefined) return false;
  const unquoted = raw.replace(/^(["'])(.*)\1$/, '$2').trim();
  return !FALSY_YAML.has(unquoted.toLowerCase());
}

/** What a file opens as, judged by its name and, for a plain `.md`, its text:
 * an Obsidian Excalidraw drawing is a canvas whatever it's called. */
export function kindFromContent(name: string, text: string): FileKind {
  const kind = kindFromName(name);
  return kind === 'note' && isExcalidrawMarkdown(text) ? 'canvas' : kind;
}

/** kindFromContent for a file in a store, reading it only when it's a `.md`. */
export async function kindOf(store: FileStore, path: string): Promise<FileKind> {
  const kind = kindFromName(path);
  return kind === 'note' ? kindFromContent(path, await store.readText(path)) : kind;
}
