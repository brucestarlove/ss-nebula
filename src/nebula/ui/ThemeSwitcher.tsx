import type { ResolvedTheme } from './useTheme';

type ThemeSwitcherProps = {
  /** The currently effective theme (resolved from mode, incl. system default). */
  value: ResolvedTheme;
  /**
   * Fired on any button click. Parent decides: clicking the *inactive* theme
   * switches theme; clicking the *active* theme toggles its background flavor.
   */
  onActivate: (theme: ResolvedTheme) => void;
  /** Whether the active theme is currently on its plain (flat) flavor. */
  isPlain?: boolean;
  size?: 'sm' | 'lg';
};

const OPTIONS: Array<{ value: ResolvedTheme; glyph: string; label: string }> = [
  { value: 'light', glyph: '☀', label: 'Light' },
  { value: 'dark', glyph: '☾', label: 'Dark' },
];

/**
 * Light / dark toggle that doubles as a background-flavor switch: clicking the
 * already-active button toggles that theme's flavor (parchment↔white,
 * starfield↔black). A small dot marks the active button when it's on the plain
 * flavor.
 */
export function ThemeSwitcher({ value, onActivate, isPlain = false, size = 'sm' }: ThemeSwitcherProps) {
  return (
    <div className="segmented" role="radiogroup" aria-label="Theme" data-size={size}>
      {OPTIONS.map((option) => {
        const isActive = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            className="segmented-option nebula-theme-option"
            role="radio"
            aria-checked={isActive}
            data-flavor={isActive && isPlain ? 'plain' : undefined}
            onClick={() => onActivate(option.value)}
            title={isActive ? 'Click again to switch background style' : `${option.label} theme`}
          >
            <span aria-hidden="true">{option.glyph}</span>
            <span className="nebula-sr-only">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export default ThemeSwitcher;
