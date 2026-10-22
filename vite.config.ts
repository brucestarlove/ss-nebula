import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { excalidrawFonts } from './scripts/excalidrawFonts'

/**
 * Records which modules each output chunk holds and which chunks it imports,
 * in the file named by NEBULA_CHUNK_REPORT. scripts/build-site.mjs asks for
 * dist/site-chunks.json, outside the deployed folder, and
 * e2e/app-budget.spec.ts reads it to prove what the first load carries.
 */
function chunkReport(): Plugin {
  return {
    name: 'nebula-chunk-report',
    apply: 'build',
    generateBundle(_options, bundle) {
      const target = process.env.NEBULA_CHUNK_REPORT
      if (!target) return
      const name = (id: string) => (isAbsolute(id) ? relative(process.cwd(), id) : id).replaceAll('\\', '/')
      const chunks: Record<string, unknown> = {}
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'chunk') continue
        chunks[fileName] = {
          isEntry: output.isEntry,
          isDynamicEntry: output.isDynamicEntry,
          imports: output.imports,
          dynamicImports: output.dynamicImports,
          modules: Object.fromEntries(Object.entries(output.modules).map(([id, module]) => [name(id), module.renderedLength])),
        }
      }
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, `${JSON.stringify({ chunks }, null, 1)}\n`)
    },
  }
}

function manualChunks(id: string): string | undefined {
  const moduleId = id.replaceAll('\\', '/')

  // Keep the React runtime easy to identify and cache independently of Nebula.
  if (moduleId.includes('/node_modules/react/') || moduleId.includes('/node_modules/react-dom/')) {
    return 'vendor-react'
  }

  // The standalone app imports Starscape UI globals once. Give those assets a
  // stable debug name now; a future Suite embed can provide equivalent host CSS
  // instead of treating this app entry as the library contract.
  if (moduleId.includes('/node_modules/@starscapedigital/ui-v3-css/')) {
    return 'starscape-ui'
  }

  // The canvas (Excalidraw, src/nebula/excalidraw, src/nebula/storage) has no
  // manual chunk of its own: a manual chunk takes in its modules' shared
  // dependencies too (the theme hooks, the context, ss-ui-react), and the
  // workspace's first load then had to fetch all 1.2 MB of it. Left alone,
  // Rollup gives each lazy view its own chunk (NebulaExcalidrawShell-*.js,
  // CanvasView-*.js) and shares only what they share.

  return undefined
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react(), excalidrawFonts(), chunkReport()],
  test: {
    // Playwright owns e2e/ (playwright.config.ts).
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
  server: {
    port: 13702,
  },
  preview: {
    port: 13702,
  },
  build: {
    target: 'es2022',
    cssCodeSplit: true,
    sourcemap: false,
    assetsDir: 'assets',
    // Excalidraw lazily emits large Mermaid/font-worker chunks. Keep the warning
    // threshold above those intentional upstream-owned chunks so warnings point
    // at new accidental app-shell regressions instead of known canvas internals.
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        manualChunks,
      },
    },
  },
})
