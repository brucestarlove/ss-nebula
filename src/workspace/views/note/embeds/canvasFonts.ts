/**
 * The fonts a drawing's text uses, put inside its SVG preview. A picture
 * can't borrow the page's fonts, and Excalidraw's own way of embedding them
 * (glyph subsetting) needs `new Function`, which the site's Content-Security-
 * Policy forbids (it skips the subsetting, logs an error, and the browser
 * reports a violation each time). So the preview is exported without fonts,
 * and the Latin face of each family it uses is read from the app's own
 * `fonts/` folder (scripts/excalidrawFonts.ts puts them there) and embedded
 * as it is. A family not listed (Xiaolai, 13 MB of Chinese), or a font that
 * can't be read, is left to the browser's fallback: the text still reads.
 *
 * The file names are those of @excalidraw/excalidraw 0.18.x; after an
 * upgrade a name that moved only costs that font (the preview falls back).
 */
const FONT_FILES: Record<string, string> = {
  Excalifont: 'Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2',
  Virgil: 'Virgil/Virgil-Regular.woff2',
  Helvetica: 'Liberation/LiberationSans-Regular.woff2',
  'Liberation Sans': 'Liberation/LiberationSans-Regular.woff2',
  Cascadia: 'Cascadia/CascadiaCode-Regular.woff2',
  'Comic Shanns': 'ComicShanns/ComicShanns-Regular-279a7b317d12eb88de06167bd672b4b4.woff2',
  'Lilita One': 'Lilita/Lilita-Regular-i7dPIFZ9Zz-WBtRtedDbYEF8RXi4EwQ.woff2',
  Nunito: 'Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTQ3j6zbXWjgeg.woff2',
  Assistant: 'Assistant/Assistant-Regular.woff2',
};

export type Fetcher = (url: string) => Promise<Response>;

const cache = new Map<string, Promise<string | null>>();

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

async function load(url: string, fetcher: Fetcher): Promise<string | null> {
  try {
    const response = await fetcher(url);
    if (!response.ok) return null;
    return `data:font/woff2;base64,${base64(new Uint8Array(await response.arrayBuffer()))}`;
  } catch {
    return null;
  }
}

/** The first family of a `font-family` value, unquoted: `"Excalifont, Xiaolai"` is Excalifont. */
export function firstFamily(value: string): string {
  return (value.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');
}

/** `@font-face` rules for the families asked for that Nebula carries, ready to put in a <style>. */
export async function fontFaceCss(families: Iterable<string>, assetPath: string, fetcher: Fetcher = (url) => fetch(url)): Promise<string> {
  const base = assetPath.endsWith('/') ? assetPath : `${assetPath}/`;
  const rules: string[] = [];
  for (const family of new Set(families)) {
    const file = FONT_FILES[family];
    if (!file) continue;
    const url = `${base}fonts/${file}`;
    let data = cache.get(url);
    if (!data) {
      data = load(url, fetcher);
      cache.set(url, data);
    }
    const source = await data;
    // A font that couldn't be read is tried again by the next preview.
    if (source === null) cache.delete(url);
    else rules.push(`@font-face{font-family:"${family}";src:url(${source}) format("woff2");}`);
  }
  return rules.join('\n');
}

/** Forgets the fonts read so far (tests). */
export function forgetFonts(): void {
  cache.clear();
}
