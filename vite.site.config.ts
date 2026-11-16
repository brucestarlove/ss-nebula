import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The landing page at nebula.starscape.app/ (site/), built into dist/site
// beside the app by scripts/build-site.mjs. Its files are named as the app's
// are (assets/[name]-[hash]), so the fonts and logo it shares with the app
// come out as the same files, cached once. public/ is the app's: its icons,
// manifest and social image are already at the root, so the landing only
// points at them.
export default defineConfig({
  root: 'site',
  base: '/',
  publicDir: '../public',
  build: {
    outDir: '../dist/site',
    emptyOutDir: false,
    copyPublicDir: false,
    target: 'es2022',
    assetsDir: 'assets',
    sourcemap: false,
    rollupOptions: {
      input: { landing: fileURLToPath(new URL('./site/index.html', import.meta.url)) },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: { port: 4346, fs: { allow: ['..'] } },
})
