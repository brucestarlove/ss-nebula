/** Planet colours, chosen to read as planets on the night sky and on
 * parchment (round 2 of the sketch). Projects can also take any colour. */
export const PLANET_COLOURS = [
  { name: 'Periwinkle', value: '#7c8cff' },
  { name: 'Violet', value: '#a78bfa' },
  { name: 'Orchid', value: '#e879f9' },
  { name: 'Rose', value: '#f472b6' },
  { name: 'Coral', value: '#fb7a5a' },
  { name: 'Amber', value: '#fbbf24' },
  { name: 'Green', value: '#4ade80' },
  { name: 'Teal', value: '#2dd4bf' },
  { name: 'Cyan', value: '#38d1eb' },
  { name: 'Blue', value: '#60a5fa' },
  { name: 'Silver', value: '#a8b0c4' },
] as const;

export const DEFAULT_PLANET_COLOUR = PLANET_COLOURS[0].value;
