import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { startStarscape } from '@starlove/ui/starscape'

import './nebula/style'
import App from './App.tsx'
import { initThemeFromStorage, resolveStoredTheme } from './nebula/ui/useTheme'
import { initMotionFromStorage } from './nebula/ui/useMotion'
import { initBackgroundFromStorage } from './nebula/ui/useBackground'

// Apply the stored theme + motion + background flavor before first paint, so
// there's no theme/flavor flash and the starfield starts calm (motion defaults
// off in Nebula).
initThemeFromStorage()
initMotionFromStorage()
initBackgroundFromStorage(resolveStoredTheme())

// Mount the shared Starscape background once for the whole app. It builds a
// fixed, full-viewport `.grain` at z-index 0 that the shell (z-index 1) floats
// over; the Excalidraw canvas is transparent so this shows through it. The
// engine self-syncs to <html data-theme> — full starfield in dark, asleep in
// light (where the package's parchment background owns <body>).
startStarscape()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
