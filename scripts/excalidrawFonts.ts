/**
 * Excalidraw's fonts, served by this site rather than esm.sh. Excalidraw loads each font from `window.EXCALIDRAW_ASSET_PATH` +
 * `fonts/<Family>/<file>.woff2`, and only falls back to esm.sh when that
 * fails; main.tsx points the path at the app's base. This plugin puts the
 * package's fonts there: copied into every app build's `fonts/` folder, and
 * served from node_modules by the dev server. The library build
 * (vite.lib.config.ts) leaves the fonts to the host app.
 */
import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

/** Where the Excalidraw package keeps its fonts (dist/prod/fonts). */
export function excalidrawFontsDir(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('@excalidraw/excalidraw')), 'fonts');
}

const FONT_PATH = /^\/fonts\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-][A-Za-z0-9_.-]*\.woff2)$/;

/** The font file a request path names (`/fonts/<Family>/<file>.woff2`), or
 * null for anything else, including any way out of the folder. */
export function fontFile(pathname: string, dir: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const match = FONT_PATH.exec(decoded);
  if (!match) return null;
  const file = join(dir, match[1], match[2]);
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

const FALLBACK_PUSH = /([\w$]+)\.push\(new URL\(([\w$]+),\s*([\w$]+)\.ASSETS_FALLBACK_URL\)\)/g;

/**
 * Excalidraw's code with the esm.sh font fallback added only when the app
 * gives no asset path. Excalidraw appends esm.sh to every font's sources, and
 * the browser checks each source against the Content-Security-Policy as the
 * font is declared, so a canvas logged 230 blocked loads. Code that doesn't
 * mention the fallback comes back unchanged; code that mentions it in a shape
 * this doesn't recognise (a new Excalidraw) stops the build.
 */
export function withoutFontFallback(code: string): string {
  if (!code.includes('ASSETS_FALLBACK_URL')) return code;
  let found = 0;
  const out = code.replace(FALLBACK_PUSH, (push, urls: string) => {
    found += 1;
    return `${urls}.length||${push}`;
  });
  if (found !== 1) {
    throw new Error(`excalidrawFonts: expected one push of ASSETS_FALLBACK_URL in Excalidraw's font code, found ${found}; check scripts/excalidrawFonts.ts against this Excalidraw.`);
  }
  return out;
}

const EXCALIDRAW_DIST = /[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/].*\.js$/;

/** Copies the fonts into a build's output folder, as `fonts/`. */
export function copyExcalidrawFonts(outDir: string): void {
  cpSync(excalidrawFontsDir(), join(outDir, 'fonts'), { recursive: true });
}

export function excalidrawFonts(): Plugin {
  return {
    name: 'nebula-excalidraw-fonts',
    // The dev server pre-bundles Excalidraw with esbuild, which plugin
    // transforms don't reach: patch it there too.
    config() {
      return {
        optimizeDeps: {
          esbuildOptions: {
            plugins: [
              {
                name: 'nebula-excalidraw-font-fallback',
                setup(build) {
                  build.onLoad({ filter: EXCALIDRAW_DIST }, async (args) => {
                    const code = await readFile(args.path, 'utf8');
                    return code.includes('ASSETS_FALLBACK_URL') ? { contents: withoutFontFallback(code), loader: 'js' } : undefined;
                  });
                },
              },
            ],
          },
        },
      };
    },
    transform(code, id) {
      if (!EXCALIDRAW_DIST.test(id.split('?')[0])) return null;
      const out = withoutFontFallback(code);
      return out === code ? null : { code: out, map: null };
    },
    configureServer(server) {
      const dir = excalidrawFontsDir();
      server.middlewares.use((req, res, next) => {
        const file = fontFile(new URL(req.url ?? '/', 'http://nebula.local').pathname, dir);
        if (!file) return next();
        res.setHeader('content-type', 'font/woff2');
        createReadStream(file).pipe(res);
      });
    },
    writeBundle(options) {
      if (options.dir) copyExcalidrawFonts(options.dir);
    },
  };
}
