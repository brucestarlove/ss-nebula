/* The @starlove/ui CSS package exposes raw .css files via subpath
 * exports (e.g. "@starlove/ui/tokens"). These are side-effect
 * imports with no type declarations, so declare them as empty modules. */
declare module '@starlove/ui';
declare module '@starlove/ui/*';

/* The starscape subpath is real JS (the dark-mode background engine), not CSS.
 * Declare it explicitly so it wins over the wildcard above and keeps its types
 * instead of resolving to `any`. */
declare module '@starlove/ui/starscape' {
  export interface StarscapeOptions {
    mountTo?: Element | string;
    signatureStars?: number;
    canvasStars?: boolean;
    meteors?: boolean;
    parallax?: boolean;
    meteorMinDelay?: number;
    meteorMaxDelay?: number;
    densityScale?: number;
  }
  export interface StarscapeHandle {
    sync(): void;
    stop(): void;
  }
  export function startStarscape(options?: StarscapeOptions): StarscapeHandle;
}
