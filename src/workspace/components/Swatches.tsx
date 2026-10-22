import { useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { PLANET_COLOURS } from '../../files/palette';
import { Button } from './Button';
import { handleRadioKeys } from './hooks';

type SwatchesProps = {
  value: string;
  onChange: (colour: string) => void;
  label: string;
  /** 'radio' in dialogs and Settings; 'menu' inside a right-click menu. */
  variant?: 'radio' | 'menu';
  className?: string;
  /** The colours offered before any colour at all: the planets by default. */
  colours?: ReadonlyArray<{ name: string; value: string }>;
  /** Shown, but can't be changed (a read-only project list). */
  disabled?: boolean;
};

/** The eleven planet colours as small planets (or the colours given), then
 * any colour at all. */
export function Swatches({ value, onChange, label, variant = 'radio', className, colours = PLANET_COLOURS, disabled = false }: SwatchesProps) {
  const values = colours.map((colour) => colour.value as string);
  const current = value.toLowerCase();
  const known = values.includes(current);
  const menu = variant === 'menu';
  const picker = useRef<HTMLInputElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (menu) return; // the menu moves Up and Down through every item
    if (event.target instanceof HTMLInputElement) return;
    handleRadioKeys(event, values, known ? current : values[0], onChange);
  };

  return (
    <div
      className={['ws-swatches', className ?? ''].filter(Boolean).join(' ')}
      role={menu ? 'group' : 'radiogroup'}
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {colours.map((colour, index) => {
        const checked = colour.value === current;
        const tabbable = menu ? undefined : checked || (!known && index === 0) ? 0 : -1;
        return (
          <Button
            key={colour.value}
            className="ws-swatch"
            role={menu ? 'menuitemradio' : 'radio'}
            aria-checked={checked}
            aria-label={colour.name}
            title={colour.name}
            tabIndex={tabbable}
            style={{ '--planet': colour.value } as CSSProperties}
            disabled={disabled}
            onClick={() => onChange(colour.value)}
          />
        );
      })}
      {menu ? (
        // In a menu, the wheel is a menu item that opens the browser's
        // picker; the input sits beside it, out of the accessibility tree
        // (a menu may hold only its items, and an item can't hold a control).
        <>
          <Button
            className="ws-swatch ws-swatch-custom"
            role="menuitemradio"
            aria-checked={!known}
            aria-label="Any colour"
            title="Any colour"
            data-chosen={known ? undefined : ''}
            disabled={disabled}
            style={{ '--custom': known ? 'transparent' : current } as CSSProperties}
            onClick={() => {
              const input = picker.current;
              if (!input) return;
              try {
                input.showPicker();
              } catch {
                input.click();
              }
            }}
          />
          <input
            ref={picker}
            className="ws-swatch-picker"
            type="color"
            tabIndex={-1}
            aria-hidden="true"
            value={current}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value.toLowerCase())}
          />
        </>
      ) : (
        <label
          className="ws-swatch ws-swatch-custom"
          title="Any colour"
          data-chosen={known ? undefined : ''}
          style={{ '--custom': known ? 'transparent' : current } as CSSProperties}
        >
          <input type="color" aria-label="Any colour" value={current} disabled={disabled} onChange={(event) => onChange(event.target.value.toLowerCase())} />
        </label>
      )}
    </div>
  );
}
