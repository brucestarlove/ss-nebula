import { compressToBase64, decompressFromBase64 } from 'lz-string';

import { normalizeExcalidrawScene, type ExcalidrawScene } from './scene';

const FRONTMATTER = `---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---`;
const OBSIDIAN_EXCALIDRAW_WARNING =
  "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'";

const COMPRESSED_DRAWING_RE = /(?:^|\n)##? Drawing\n[\s\S]*?```compressed-json\n([\s\S]*?)```/m;
const JSON_DRAWING_RE = /(?:^|\n)##? Drawing\n[\s\S]*?```json\n([\s\S]*?)```/m;

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

export function isObsidianExcalidrawMarkdown(value: string): boolean {
  return (
    /excalidraw-plugin:\s*(raw|parsed)/.test(value) ||
    (/(?:^|\n)# Excalidraw Data(?:\n|$)/.test(value) && /(?:^|\n)##? Drawing\n/.test(value)) ||
    /```compressed-json\n/.test(value)
  );
}

export function readObsidianExcalidrawMarkdown(value: string): ExcalidrawScene {
  const compressed = value.match(COMPRESSED_DRAWING_RE)?.[1];
  if (compressed) {
    const json = decompressObsidianMarkdownPayload(compressed);
    if (!json) throw new Error('Could not decompress Obsidian Excalidraw drawing data.');
    return parseSceneJson(json);
  }

  const json = value.match(JSON_DRAWING_RE)?.[1];
  if (json) return parseSceneJson(json);

  throw new Error('Selected Markdown file does not contain an Obsidian Excalidraw drawing section.');
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

export function getObsidianTextElementsSection(scene: ExcalidrawScene): string {
  const entries = scene.elements
    .filter((element) => element.type === 'text')
    .map((element) => {
      const text = textForElement(element);
      return text ? `${text} ^${element.id}` : null;
    })
    .filter((entry): entry is string => Boolean(entry));

  return entries.length > 0 ? entries.join('\n\n') : '';
}

export function toObsidianExcalidrawMarkdown(scene: ExcalidrawScene, options: { compressed?: boolean } = {}): string {
  const normalized = toObsidianCompatibleScene(scene);
  const json = JSON.stringify(normalized, null, 2);
  const drawing = options.compressed === false
    ? `## Drawing\n\`\`\`json\n${json}\n\`\`\`\n%%`
    : `## Drawing\n\`\`\`compressed-json\n${compressForObsidianMarkdown(json)}\n\`\`\`\n%%`;
  const textElements = getObsidianTextElementsSection(normalized);

  return `${FRONTMATTER}\n${OBSIDIAN_EXCALIDRAW_WARNING}\n\n\n# Excalidraw Data\n\n## Text Elements\n${textElements ? `${textElements}\n\n` : '\n'}%%\n${drawing}`;
}
