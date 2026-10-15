/// <reference types="vite/client" />

declare const __APP_VERSION__: string

// Electron's frameless-window drag region — not part of the standard CSS property set that
// csstype (and therefore React.CSSProperties) knows about.
declare module 'csstype' {
  interface Properties {
    WebkitAppRegion?: 'drag' | 'no-drag'
  }
}
