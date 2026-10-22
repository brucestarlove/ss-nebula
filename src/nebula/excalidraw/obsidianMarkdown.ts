import { compressToBase64, decompressFromBase64 } from 'lz-string';

import { normalizeExcalidrawScene, type ExcalidrawScene } from './scene';

const FRONTMATTER = `---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---`;
const OBSIDIAN_EXCALIDRAW_WARNING =
  "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'";


const OBSIDIAN_EXCALIDRAW_APP_STATE_DEFAULTS: Record<string, unknown> = {
  theme: 'light',
  viewBackgroundColor: '#ffffff',
  currentItemStrokeColor: '#1e1e1e',
  currentItemBackgroundColor: 'transparent',
  currentItemFillStyle: 'solid',
  currentItemStrokeWidth: 2,
  currentItemStrokeStyle: 'solid',
  currentItemRoughness: 1,
  currentItemOpacity: 100,
  currentItemFontFamily: 5,
  currentItemFontSize: 20,
  currentItemTextAlign: 'left',
  currentItemStartArrowhead: null,
  currentItemEndArrowhead: 'arrow',
  currentItemArrowType: 'round',
  currentItemFrameRole: null,
  scrollX: 0,
  scrollY: 0,
  zoom: { value: 1 },
  currentItemRoundness: 'round',
  gridSize: null,
  gridStep: 5,
  gridModeEnabled: false,
  gridColor: { Bold: '#C9C9C9FF', Regular: '#EDEDEDFF' },
  currentStrokeOptions: null,
  frameRendering: {
    enabled: true,
    clip: true,
    name: true,
    outline: true,
    markerName: true,
    markerEnabled: true,
  },
  objectsSnapModeEnabled: false,
  activeTool: {
    type: 'selection',
    customType: null,
    locked: false,
    fromSelection: false,
    lastActiveTool: null,
  },
  disableContextMenu: false,
  colorPalette: {},
  previousGridSize: null,
};

// The only appState keys genuine Obsidian Excalidraw files contain (observed
// across plugin builds 2.19.x–2.22.x). Excalidraw's live runtime appState
// carries dozens of additional ephemeral keys (selection state, editing ids,
// presence Maps, etc.). Persisting those into the Obsidian envelope is what
// destabilizes the plugin's restore path, so we emit exactly this shape and
// nothing more. Notably `collaborators` is intentionally absent: Excalidraw
// expects a Map there and defaults it itself, so a serialized array/object
// value is precisely the kind of thing that triggers `collaborators.forEach`
// crashes on import.
const OBSIDIAN_EXCALIDRAW_APP_STATE_KEYS = new Set<string>([
  ...Object.keys(OBSIDIAN_EXCALIDRAW_APP_STATE_DEFAULTS),
  'bindingPreference',
  'isBindingEnabled',
  'isMidpointSnappingEnabled',
  'boxSelectionMode',
]);

function chunkBase64(value: string): string {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += 256) {
    chunks.push(value.slice(index, index + 256));
  }
  return chunks.join('\n\n');
}

function compressForObsidianMarkdown(json: string): string {
  return chunkBase64(compressToBase64(json)).trim();
}

function decompressObsidianMarkdownPayload(payload: string): string | null {
  const compact = payload.replace(/[\n\r]/g, '');
  if (!compact) return null;
  return decompressFromBase64(compact) || null;
}

function parseSceneJson(value: string): ExcalidrawScene {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as ExcalidrawScene).elements)) {
    throw new Error('Obsidian Excalidraw drawing section does not contain a valid Excalidraw scene.');
  }
  return normalizeExcalidrawScene(parsed as ExcalidrawScene);
}

function toObsidianCompatibleAppState(appState: ExcalidrawScene['appState']): ExcalidrawScene['appState'] {
  const normalized = normalizeExcalidrawScene({ elements: [], appState }).appState ?? {};

  // Start from the canonical Obsidian defaults, then overlay only the live
  // appState keys Obsidian itself persists. Everything else from Excalidraw's
  // runtime appState (including `collaborators`) is deliberately dropped so the
  // exported envelope matches a genuine plugin-authored file's shape exactly.
  const filtered: Record<string, unknown> = { ...OBSIDIAN_EXCALIDRAW_APP_STATE_DEFAULTS };
  for (const [key, value] of Object.entries(normalized)) {
    if (OBSIDIAN_EXCALIDRAW_APP_STATE_KEYS.has(key)) filtered[key] = value;
  }

  // Nebula renders its canvas with a transparent background so the themed app
  // surface (the Starscape starfield / parchment) shows through. Obsidian has
  // nothing behind the canvas, so a transparent value paints solid black in both
  // appearance modes. Genuine plugin files always carry a solid color, so we
  // restore the default rather than leaking Nebula's app-only transparent hack.
  if (filtered.viewBackgroundColor === 'transparent' || !filtered.viewBackgroundColor) {
    filtered.viewBackgroundColor = OBSIDIAN_EXCALIDRAW_APP_STATE_DEFAULTS.viewBackgroundColor;
  }

  // Nebula follows the app's own dark/light theme, but Excalidraw's dark theme
  // applies a full-canvas invert filter — so exporting theme:"dark" makes the
  // (now solid white) background render black in Obsidian regardless of its
  // appearance mode. The Obsidian plugin re-syncs the canvas theme to the vault
  // on open, so we export the neutral light theme and let Obsidian own it.
  filtered.theme = OBSIDIAN_EXCALIDRAW_APP_STATE_DEFAULTS.theme;

  return filtered;
}

function toObsidianCompatibleElement(element: ExcalidrawScene['elements'][number]): ExcalidrawScene['elements'][number] {
  const normalized = { ...element };

  // Obsidian Excalidraw's restore path is less tolerant than the web package
  // about nullable collection fields on elements. In plugin-authored files these
  // are arrays even when empty; upstream Excalidraw runtime data can hand Nebula
  // null/undefined values such as `boundElements: null` on text elements.
  normalized.groupIds = Array.isArray(normalized.groupIds) ? normalized.groupIds : [];
  normalized.boundElements = Array.isArray(normalized.boundElements) ? normalized.boundElements : [];

  if (!('frameId' in normalized)) normalized.frameId = null;
  if (!('link' in normalized)) normalized.link = null;
  if (!('locked' in normalized)) normalized.locked = false;

  if (normalized.type === 'text') {
    if (!('containerId' in normalized)) normalized.containerId = null;
    if (!('originalText' in normalized) && typeof normalized.text === 'string') normalized.originalText = normalized.text;
    if (!('lineHeight' in normalized)) normalized.lineHeight = 1.25;
  }

  return normalized;
}

function toObsidianCompatibleScene(scene: ExcalidrawScene): ExcalidrawScene {
  const normalized = normalizeExcalidrawScene(scene);

  return {
    ...normalized,
    elements: normalized.elements.map(toObsidianCompatibleElement),
    appState: toObsidianCompatibleAppState(normalized.appState),
    files: normalized.files ?? {},
  };
}

function textForElement(element: Record<string, unknown>): string | null {
  const text = typeof element.rawText === 'string'
    ? element.rawText
    : typeof element.originalText === 'string'
      ? element.originalText
      : typeof element.text === 'string'
        ? element.text
        : null;
  return text && text.trim() ? text : null;
}

type DrawingBlock = {
  /** Where the `## Drawing` heading line starts. */
  start: number;
  /** Just past the closing fence's backticks. */
  end: number;
  compressed: boolean;
  payload: string;
};

const DRAWING_HEADING_RE = /(^|\n)##? Drawing[ \t]*\r?\n/g;
// As the plugin allows: anything but a backtick between the heading and its fence.
const DRAWING_FENCE_RE = /^[^`]*?```(compressed-json|json)[ \t]*\r?\n/;
const CLOSING_FENCE_RE = /(^|\n)```/;

/** The drawing block: the last `## Drawing` heading followed by a json or
 * compressed-json fence (review finding 9). A text element can hold a
 * pasted heading and fence of its own, and text elements come first. */
function findDrawingBlock(value: string): DrawingBlock | null {
  const headings = [...value.matchAll(DRAWING_HEADING_RE)];
  for (let index = headings.length - 1; index >= 0; index -= 1) {
    const heading = headings[index];
    const start = (heading.index ?? 0) + heading[1].length;
    const afterHeading = (heading.index ?? 0) + heading[0].length;
    const fence = DRAWING_FENCE_RE.exec(value.slice(afterHeading));
    if (!fence) continue;
    const payloadStart = afterHeading + fence[0].length;
    const close = CLOSING_FENCE_RE.exec(value.slice(payloadStart));
    if (!close) continue;
    return {
      start,
      end: payloadStart + close.index + close[0].length,
      compressed: fence[1] === 'compressed-json',
      payload: value.slice(payloadStart, payloadStart + close.index),
    };
  }
  return null;
}

function sceneFromBlock(block: DrawingBlock): ExcalidrawScene {
  if (!block.compressed) return parseSceneJson(block.payload);
  const json = decompressObsidianMarkdownPayload(block.payload);
  if (!json) throw new Error('Could not decompress Obsidian Excalidraw drawing data.');
  return parseSceneJson(json);
}

export function isObsidianExcalidrawMarkdown(value: string): boolean {
  return (
    /excalidraw-plugin:\s*(raw|parsed)/.test(value) ||
    (/(?:^|\n)# Excalidraw Data(?:\n|$)/.test(value) && /(?:^|\n)##? Drawing\n/.test(value)) ||
    /```compressed-json\n/.test(value)
  );
}

// The leading frontmatter block: '---' on the very first line (a byte-order
// mark aside), then whole lines up to a closing '---' or '...'.
const LEADING_FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n((?:[^\n]*\n)*?)(?:---|\.\.\.)[ \t]*\r?(?:\n|$)/;
const PLUGIN_KEY_RE = /^["']?excalidraw-plugin["']?[ \t]*:[ \t]*(.*?)[ \t]*\r?$/m;
const FALSY_YAML = new Set(['', 'false', 'null', '~', '0']);

/** True when the text is a drawing the way Obsidian decides it: the
 * `excalidraw-plugin` key, with a value, in the leading frontmatter block.
 * Use this to decide what a `.md` file is; a note that quotes a drawing or
 * mentions the key is still a note (review finding 8).
 * isObsidianExcalidrawMarkdown() stays lenient for the explicit Import, where
 * the user picked the file. src/files/kinds.ts repeats this test (the canvas
 * chunk mustn't load with the file tree); its tests keep the two equal. */
export function isObsidianExcalidrawFile(value: string): boolean {
  const frontmatter = LEADING_FRONTMATTER_RE.exec(value)?.[1];
  if (frontmatter === undefined) return false;
  const raw = PLUGIN_KEY_RE.exec(frontmatter)?.[1];
  if (raw === undefined) return false;
  const unquoted = raw.replace(/^(["'])(.*)\1$/, '$2').trim();
  return !FALSY_YAML.has(unquoted.toLowerCase());
}

/** The scene in a drawing file: the block after the last `## Drawing`
 * heading. A payload that doesn't decode fails this file only, with the
 * reason. */
export function readObsidianExcalidrawMarkdown(value: string): ExcalidrawScene {
  const block = findDrawingBlock(value);
  if (!block) throw new Error('Selected Markdown file does not contain an Obsidian Excalidraw drawing section.');
  return sceneFromBlock(block);
}

export function getObsidianExcalidrawInteropFilename(
  boardSlug: string | undefined,
  boardId: string,
  canvasId: string,
): string {
  const safeBoard = (boardSlug || boardId)
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'ss-nebula';
  const safeCanvas = canvasId.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'main';
  return `${safeBoard}-${safeCanvas}.excalidraw.md`;
}

const FENCE_LINE_RE = /^( {0,3})(`{3,}|~{3,})/;
const SECTION_LINE_RE = /^( {0,3}#{1,2})( +(?:Drawing|Excalidraw Data|Text Elements|Element Links|Embedded Files|Markdown Images)[ \t]*)$/i;
const ZERO_WIDTH_SPACE = '\u200B';

/** A text element's text as the `## Text Elements` copy shows it (review
 * finding 9): a line that opens a code fence, or that reads as one of the
 * file's own section headings, gets a zero-width space, so neither Nebula
 * nor the plugin (which takes the first `## Drawing`) can mistake it for the
 * drawing or a section. The drawing's JSON keeps the text exactly; the plugin
 * reads its text elements from this copy, so there they carry the invisible
 * character. Everything else stays as written. */
function readableCopy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(FENCE_LINE_RE, `$1${ZERO_WIDTH_SPACE}$2`).replace(SECTION_LINE_RE, `$1${ZERO_WIDTH_SPACE}$2`))
    .join('\n');
}

/** One `text ^id` entry per text element still in the drawing. The plugin
 * reads them back with /\s\^(.{8})\n+/, so entries under its 8-character
 * ids come first: the text of a longer id (one made in Nebula) would
 * otherwise be read as the start of the next 8-character entry. Entries the
 * file already had keep its `order` (re-review R9: a vault in git shouldn't
 * see them shuffled on the first save); new ones follow, in scene order. */
function textElementEntries(scene: ExcalidrawScene, order: string[] = []): string[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  const entries = scene.elements
    .filter((element) => element.type === 'text' && element.isDeleted !== true)
    .map((element) => {
      const text = textForElement(element);
      return text ? { id: String(element.id), entry: `${readableCopy(text)} ^${element.id}` } : null;
    })
    .filter((entry): entry is { id: string; entry: string } => entry !== null);
  const kept = entries.filter((entry) => rank.has(entry.id)).sort((a, b) => (rank.get(a.id) as number) - (rank.get(b.id) as number));
  entries.splice(0, entries.length, ...kept, ...entries.filter((entry) => !rank.has(entry.id)));
  return [...entries.filter((entry) => entry.id.length === 8), ...entries.filter((entry) => entry.id.length !== 8)].map((entry) => entry.entry);
}

export function getObsidianTextElementsSection(scene: ExcalidrawScene): string {
  return textElementEntries(scene).join('\n\n');
}

/** What follows `## Text Elements`: each entry and a blank line, as the plugin writes them. */
function textElementsBody(scene: ExcalidrawScene, order: string[] = []): string {
  const entries = textElementEntries(scene, order);
  return entries.length > 0 ? entries.map((entry) => `${entry}\n\n`).join('') : '\n';
}

/** The `## Drawing` heading and its fence, without the closing `%%`. */
function drawingSection(scene: ExcalidrawScene, compressed: boolean): string {
  const json = JSON.stringify(scene, null, 2);
  return compressed
    ? `## Drawing\n\`\`\`compressed-json\n${compressForObsidianMarkdown(json)}\n\`\`\``
    : `## Drawing\n\`\`\`json\n${json}\n\`\`\``;
}

export function toObsidianExcalidrawMarkdown(scene: ExcalidrawScene, options: { compressed?: boolean } = {}): string {
  const normalized = toObsidianCompatibleScene(scene);
  return `${FRONTMATTER}\n${OBSIDIAN_EXCALIDRAW_WARNING}\n\n\n# Excalidraw Data\n\n## Text Elements\n${textElementsBody(normalized)}%%\n${drawingSection(normalized, options.compressed !== false)}\n%%`;
}

const DATA_HEADING_RE = /(^|\n)(?:%%[ \t]*\r?\n)?# Excalidraw Data[ \t]*\r?(?:\n|$)/;
const TEXT_HEADING_RE = /(^|\n)##? Text Elements[ \t]*\r?\n/;
const BLOCK_REF_RE = /[ \t]\^([^\s^]+)[ \t]*\r?(?=\n|$)/g;
const PLUGIN_KEY_LINE_RE = /^["']?excalidraw-plugin["']?[ \t]*:.*$/m;

/** Where the text elements sit: from just after `## Text Elements` to just
 * after the last entry of an element the drawing has (and the blank lines
 * after it). Text elements may hold headings of their own, so the end is
 * found by block refs, not by the next heading. */
function textElementsRegion(value: string, drawingStart: number, ids: Set<string>): { start: number; end: number } | null {
  const before = value.slice(0, drawingStart);
  const data = DATA_HEADING_RE.exec(before);
  const from = data ? data.index + data[0].length : 0;
  const heading = TEXT_HEADING_RE.exec(before.slice(from));
  if (!heading) return null;
  const start = from + heading.index + heading[0].length;
  let end = start;
  for (const match of before.slice(start).matchAll(BLOCK_REF_RE)) {
    if (ids.has(match[1])) end = start + (match.index ?? 0) + match[0].length;
  }
  while (end < drawingStart && (value[end] === '\n' || (value[end] === '\r' && value[end + 1] === '\n'))) end += value[end] === '\r' ? 2 : 1;
  return { start, end };
}

/** The text with `excalidraw-plugin: parsed` in its leading frontmatter,
 * making the block when there's none. */
function withPluginKey(value: string): string {
  if (isObsidianExcalidrawFile(value)) return value;
  const frontmatter = LEADING_FRONTMATTER_RE.exec(value);
  if (!frontmatter) return `${FRONTMATTER}\n${value}`;
  const blockStart = frontmatter[0].indexOf('\n') + 1;
  const block = frontmatter[1];
  const keyed = PLUGIN_KEY_LINE_RE.test(block) ? block.replace(PLUGIN_KEY_LINE_RE, 'excalidraw-plugin: parsed') : `excalidraw-plugin: parsed\n${block}`;
  return `${value.slice(0, blockStart)}${keyed}${value.slice(blockStart + block.length)}`;
}

function elementIds(scene: ExcalidrawScene): string[] {
  return scene.elements.map((element) => String(element.id));
}

/**
 * Saves `scene` into a drawing file the way the Obsidian plugin would,
 * keeping everything that isn't the drawing (review finding 8): the
 * frontmatter and its other keys, whatever sits above `# Excalidraw Data`
 * (the back-of-card notes), `## Element Links`, `## Embedded Files` and any
 * other section. Only the entries under `## Text Elements` and the
 * `## Drawing` block are made again. The drawing keeps its encoding (json or
 * compressed-json) unless `compressed` says otherwise. A file with no
 * drawing block gets one appended, and the frontmatter key that makes it a
 * drawing; an empty file gets what toObsidianExcalidrawMarkdown() writes.
 * What it writes takes the file's line end (re-review R7): a CRLF file stays
 * CRLF throughout, with no bare LF in the parts made again.
 */
export function updateObsidianExcalidrawMarkdown(original: string, scene: ExcalidrawScene, options: { compressed?: boolean } = {}): string {
  const updated = updateWithLineFeeds(original, scene, options);
  // A CRLF file has no bare LF (lineBreakOf), so only what was made again changes.
  return lineBreakOf(original) === '\r\n' ? updated.replace(/\r?\n/g, '\r\n') : updated;
}

/** The file's line end: CRLF when every line ends so, LF otherwise (a file
 * with mixed ends gets LF in what is written). The same rule as the text
 * views' (src/workspace/views/shared/textSession.ts). */
function lineBreakOf(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') && !/(?:^|[^\r])\n/.test(text) ? '\r\n' : '\n';
}

/** updateObsidianExcalidrawMarkdown, writing what it makes again with LF. */
function updateWithLineFeeds(original: string, scene: ExcalidrawScene, options: { compressed?: boolean }): string {
  const normalized = toObsidianCompatibleScene(scene);
  const block = findDrawingBlock(original);
  if (!block) {
    const compressed = options.compressed !== false;
    if (original.trim() === '') return toObsidianExcalidrawMarkdown(scene, { compressed });
    const head = withPluginKey(original).replace(/\s+$/, '');
    return `${head}\n\n# Excalidraw Data\n\n## Text Elements\n${textElementsBody(normalized)}%%\n${drawingSection(normalized, compressed)}\n%%`;
  }

  const compressed = options.compressed ?? block.compressed;
  const ids = new Set(elementIds(normalized));
  try {
    for (const id of elementIds(sceneFromBlock(block))) ids.add(id);
  } catch {
    // The old drawing doesn't decode: find its entries by the new scene's ids.
  }
  const drawn = `${original.slice(0, block.start)}${drawingSection(normalized, compressed)}${original.slice(block.end)}`;
  const region = textElementsRegion(drawn, block.start, ids);
  if (region) {
    const order = [...drawn.slice(region.start, region.end).matchAll(BLOCK_REF_RE)].map((match) => match[1]).filter((id) => ids.has(id));
    return `${drawn.slice(0, region.start)}${textElementsBody(normalized, order)}${drawn.slice(region.end)}`;
  }

  // No `## Text Elements` heading: put one after `# Excalidraw Data`, or
  // before the drawing (and the `%%` that opens its comment).
  const before = drawn.slice(0, block.start);
  const data = DATA_HEADING_RE.exec(before);
  const section = `## Text Elements\n${textElementsBody(normalized)}`;
  if (data) {
    const at = data.index + data[0].length;
    const gap = drawn.startsWith('\n', at) ? 1 : 0;
    return `${drawn.slice(0, at + gap)}${gap ? '' : '\n'}${section}${drawn.slice(at + gap)}`;
  }
  const comment = /(^|\n)%%[ \t]*\r?\n$/.exec(before);
  const at = comment ? comment.index + comment[1].length : block.start;
  return `${drawn.slice(0, at)}# Excalidraw Data\n\n${section}${drawn.slice(at)}`;
}
