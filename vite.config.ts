import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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

  // Preserve the lazy canvas shell as a debuggable production chunk without
  // pulling it into the initial standalone app shell.
  if (
    moduleId.endsWith('/src/nebula/NebulaExcalidrawShell.tsx') ||
    moduleId.includes('/src/nebula/excalidraw/') ||
    moduleId.includes('/src/nebula/storage/')
  ) {
    return 'nebula-canvas-shell'
  }

  return undefined
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react()],
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
