import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { startStarscape } from '@starlove/ui/starscape'

// The workspace's style entry: Nebula's own layers first (src/nebula/style),
// then the sidebar template, context menu, kbd, the Atlas fonts and
// workspace.css, in the order they must cascade.
import './workspace/style'
import App from './App.tsx'
import { initThemeFromStorage, resolveStoredTheme } from './nebula/ui/useTheme'
import { initMotionFromStorage } from './nebula/ui/useMotion'
import { initBackdropFromStorage } from './workspace/backdrop'
import { initPreferencesFromStorage } from './workspace/preferences'

// Excalidraw's fonts come from this site: every app build copies them to
// <base>fonts/ (scripts/excalidrawFonts.ts), and Excalidraw asks esm.sh only
// when this path is unset. Set before any canvas loads, as an absolute URL:
// a server's build has the relative base './', read against the page's
// <base href> (cli/app.mjs).
(window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = new URL(import.meta.env.BASE_URL, document.baseURI).href

// Apply the stored theme, motion, background (with an image's preview) and
// workspace preferences (style, page width, note text, dock) before first
// paint, so nothing flashes and the starfield starts calm (motion defaults
// off in Nebula).
initThemeFromStorage()
initMotionFromStorage()
initBackdropFromStorage(resolveStoredTheme())
initPreferencesFromStorage()

// Mount the shared Starscape background once for the whole app. It builds a
// fixed, full-viewport `.grain` at z-index 0 that the workspace floats over;
// canvases are transparent so this shows through them. The engine self-syncs
// to <html data-theme>: full starfield in dark, asleep in light (where the
// package's parchment background owns <body>).
startStarscape()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
