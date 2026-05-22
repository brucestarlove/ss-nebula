import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const externalModules = new Set([
  '@excalidraw/excalidraw',
  '@starlove/ui-react',
  'lz-string',
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
]);

function isExternal(id: string): boolean {
  return externalModules.has(id) || id.startsWith('@excalidraw/excalidraw/types');
}

function dropEmptyStyleEntry(): Plugin {
  return {
    name: 'drop-empty-style-entry',
    generateBundle(_options, bundle) {
      const styleEntry = bundle['style.js'];

      if (styleEntry?.type === 'chunk' && styleEntry.code.trim() === '') {
        delete bundle['style.js'];
      }
    },
  };
}

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    target: 'es2022',
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    lib: {
      entry: {
        index: fileURLToPath(new URL('./src/nebula/index.ts', import.meta.url)),
        style: fileURLToPath(new URL('./src/nebula/style.ts', import.meta.url)),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
      cssFileName: 'style',
    },
    rollupOptions: {
      external: isExternal,
      plugins: [dropEmptyStyleEntry()],
      output: {
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === 'style.css') return 'style.css';
          return 'assets/[name]-[hash][extname]';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
});
