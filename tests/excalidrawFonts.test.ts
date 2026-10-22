import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyExcalidrawFonts, excalidrawFontsDir, fontFile, withoutFontFallback } from '../scripts/excalidrawFonts';

// Review finding 20: Excalidraw fetched its fonts from esm.sh. The site
// serves them itself at /fonts/<Family>/<file>.woff2 (main.tsx points
// EXCALIDRAW_ASSET_PATH at the site), copied from the package into every app
// build and served from node_modules by the dev server.

function files(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as Array<{ isFile(): boolean; name: string; parentPath: string }>)
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();
}

const EXCALIFONT = 'Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2';

describe('Excalidraw’s fonts, served by this site', () => {
  const temporary: string[] = [];
  afterEach(() => {
    for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('finds the fonts the Excalidraw package ships', () => {
    const fonts = files(excalidrawFontsDir());
    expect(fonts).toContain(EXCALIFONT);
    expect(fonts).toContain('Virgil/Virgil-Regular.woff2');
    expect(fonts.every((path) => path.endsWith('.woff2'))).toBe(true);
  });

  it('maps /fonts/<Family>/<file>.woff2 to that file', () => {
    const dir = excalidrawFontsDir();
    expect(fontFile(`/fonts/${EXCALIFONT}`, dir)).toBe(join(dir, EXCALIFONT));
    expect(fontFile('/fonts/Virgil/Virgil-Regular.woff2', dir)).toBe(join(dir, 'Virgil', 'Virgil-Regular.woff2'));
  });

  it('refuses every other path: other folders and types, traversal, missing files', () => {
    const dir = excalidrawFontsDir();
    for (const path of [
      '/fonts/',
      '/fonts/Excalifont',
      '/fonts/Excalifont/',
      '/assets/Excalifont/Excalifont-Regular.woff2',
      '/fonts/../package.json',
      '/fonts/Excalifont/../../index.js',
      '/fonts/%2e%2e/%2e%2e/index.js',
      '/fonts/..%2F..%2Findex.js',
      '/fonts/Excalifont/Excalifont-Regular.woff',
      '/fonts/Excalifont/missing.woff2',
      '/fonts/Excalifont/%E0%A4%A.woff2',
      '/fonts/Excalifont/sub/x.woff2',
    ]) {
      expect(fontFile(path, dir), path).toBeNull();
    }
  });

  it('copies every font into a build, byte for byte', () => {
    const out = mkdtempSync(join(tmpdir(), 'nebula-fonts-'));
    temporary.push(out);
    copyExcalidrawFonts(out);
    const source = excalidrawFontsDir();
    expect(files(join(out, 'fonts'))).toEqual(files(source));
    expect(readFileSync(join(out, 'fonts', EXCALIFONT)).equals(readFileSync(join(source, EXCALIFONT)))).toBe(true);
  });
});

describe('Excalidraw’s esm.sh fallback', () => {
  // Excalidraw lists esm.sh after the asset path in every font's sources, and
  // the browser checks each one against the policy as the font is declared:
  // 230 blocked loads, one per font, on every canvas.
  const chunks = ['prod', 'dev'].map((build) => {
    const dir = join(excalidrawFontsDir(), '..', '..', build);
    const file = readdirSync(dir)
      .map((name) => join(dir, name))
      .find((path) => path.endsWith('.js') && readFileSync(path, 'utf8').includes('ASSETS_FALLBACK_URL'));
    return { build, code: readFileSync(file!, 'utf8') };
  });

  it('is added only when the app gives no asset path, in both of the package’s builds', () => {
    for (const { build, code } of chunks) {
      const out = withoutFontFallback(code);
      expect(out, build).not.toBe(code);
      expect(out.match(/\.length\|\|[\w$]+\.push\(new URL\([\w$]+,\s*[\w$]+\.ASSETS_FALLBACK_URL\)\)/g), build).toHaveLength(1);
      expect(out.length - code.length, build).toBeLessThan(40);
    }
  });

  it('leaves other code alone, and refuses an Excalidraw it doesn’t recognise', () => {
    expect(withoutFontFallback('export const answer = 42;')).toBe('export const answer = 42;');
    expect(() => withoutFontFallback('static ASSETS_FALLBACK_URL = "https://esm.sh/"; urls.unshift(fallback)')).toThrow(/ASSETS_FALLBACK_URL/);
  });
});
