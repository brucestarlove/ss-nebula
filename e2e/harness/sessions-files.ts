/** The sessions lane's fixtures: what each finding's check needs, small. */
import { toObsidianExcalidrawMarkdown } from '../../src/nebula/excalidraw/obsidianMarkdown';
import type { ExcalidrawScene } from '../../src/nebula/excalidraw/scene';
import winterHexagon from '../../sketches/workspace/assets/winter-hexagon.excalidraw?raw';
import { BROKEN_TEXT, CRLF_TEXT, PATHS } from './sessions-paths';

export { PROJECT_ID } from './sessions-paths';

/** Latin-1 bytes: valid as text, not as UTF-8. */
export function latin1(text: string): Blob {
  return new Blob([Uint8Array.from(Array.from(text, (char) => char.charCodeAt(0)))]);
}

export function buildFixtures(): Record<string, string | Blob> {
  const hexagon = JSON.parse(winterHexagon) as ExcalidrawScene;
  return {
    [PATHS.note]: '# Observing plan\n\nSaturday, after moonset.\n\n- [ ] Charge the batteries\n- [ ] Pack the red torch\n',
    [PATHS.moon]: '# Moon phases\n\nNew moon on the 9th.\n',
    [PATHS.web]: [
      '# Web images',
      '',
      'A tracking pixel: ![Pixel](https://tracker.example/pixel.png?note=web-images)',
      '',
      'A chart from the web: ![Orion, from the web](https://charts.example/orion.png)',
      '',
      'And one of ours: ![Winter hexagon](<Photos/Winter hexagon.png>)',
      '',
    ].join('\n'),
    [PATHS.crlf]: CRLF_TEXT,
    [PATHS.latin1]: latin1('Café au lait, crème brûlée.\n'),
    [PATHS.latin1Note]: latin1('# Carnet\n\nCafé au lait, crème brûlée.\n\n- [ ] Réserver le télescope\n'),
    [PATHS.hexagon]: toObsidianExcalidrawMarkdown(hexagon, { compressed: true }),
    [PATHS.empty]: '',
    [PATHS.broken]: BROKEN_TEXT,
  };
}
