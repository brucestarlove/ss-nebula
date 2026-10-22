/** Lane C's fixtures: one small file per kind, built in the page. */
import { toObsidianExcalidrawMarkdown } from '../../src/nebula/excalidraw/obsidianMarkdown';
import type { ExcalidrawScene } from '../../src/nebula/excalidraw/scene';
import winterHexagon from '../../sketches/workspace/assets/winter-hexagon.excalidraw?raw';

export const NOTE_PATH = 'Guides/Observing plan.md';

export const NOTE = `---
tags: [stargazing, october]
---
Saturday, after moonset. The dark site is forty minutes north, past the reservoir, and the forecast says clear until 3 am.

## Targets

- [x] Orion Nebula (M42), low in the east after 11 pm. Notes in [[Orion]].
- [ ] The Pleiades (M45). Binoculars first, then the scope.
- [ ] Andromeda (M31), before it drops into the trees.

## Pack

Red flashlight, the [[Star chart — October]], warm layers and a thermos. Forecast from [the Met Office](https://www.metoffice.gov.uk/).

> Give your eyes twenty minutes in the dark before you judge the sky.
`;

export const LONG_NOTE = `---
tags:
  - reference
---
# Field guide

A note with **every** kind of *markdown* in it, so the page can be checked: \`inline code\`, ~~struck~~ text and a #reference tag.

### Kit list

1. Tripod
2. Red torch
   - spare batteries
3. Thermos

| Object | Magnitude | Best month |
|---|---|---|
| M42 | 4.0 | January |
| M45 | 1.6 | November |

\`\`\`ts
const darkAdaptation = 20 * 60; // seconds
\`\`\`

---

<b>Raw HTML</b> stays text, and so does <script>window.__htmlRan = true</script>.

![A remote image](https://example.invalid/sky.png) and ![[Winter hexagon.excalidraw]].
`;

const SMALL_SCENE: ExcalidrawScene = {
  type: 'excalidraw',
  version: 2,
  source: 'nebula-harness',
  elements: [
    {
      id: 'scope-body',
      type: 'rectangle',
      x: 100,
      y: 100,
      width: 220,
      height: 80,
      angle: 0,
      strokeColor: '#1e1e1e',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: { type: 3 },
      seed: 1,
      version: 3,
      versionNonce: 11,
      isDeleted: false,
      boundElements: [],
      updated: 1,
      link: null,
      locked: false,
    },
  ],
  appState: { viewBackgroundColor: '#ffffff' },
  files: {},
};

function obsidianJsonMarkdown(scene: ExcalidrawScene): string {
  return toObsidianExcalidrawMarkdown(scene, { compressed: false });
}

/** A two-page PDF, written by hand with a correct cross-reference table. */
export function makePdf(): Blob {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
  ];
  const page = (text: string) => {
    const stream = `BT /F1 28 Tf 72 700 Td (${text}) Tj ET`;
    return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  };
  objects.push(page('Star chart, October'), page('Page two: the winter hexagon'));
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([body], { type: 'application/pdf' });
}

/** 1.5 seconds of a soft 440 Hz tone, 16-bit mono PCM. */
export function makeWav(seconds = 1.5, rate = 8000): Blob {
  const samples = Math.round(seconds * rate);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index += 1) {
    view.setInt16(44 + index * 2, Math.round(Math.sin((2 * Math.PI * 440 * index) / rate) * 6000), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

async function fetchBlob(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Fixture ${url}: ${response.status}`);
  return response.blob();
}

/** An SVG that tries to run a script: it must never run. */
async function hostileSvg(): Promise<string> {
  const svg = await (await fetch('/sketches/workspace/assets/winter-hexagon-night.svg')).text();
  return svg.replace('</svg>', '<script>window.__svgScriptRan = true</script></svg>');
}

export async function buildFixtures(): Promise<Record<string, string | Blob>> {
  const hexagon = JSON.parse(winterHexagon) as ExcalidrawScene;
  return {
    [NOTE_PATH]: NOTE,
    'Guides/Field guide.md': LONG_NOTE,
    'Sketches/Winter hexagon.excalidraw.md': toObsidianExcalidrawMarkdown(hexagon, { compressed: true }),
    'Sketches/Telescope setup.excalidraw': JSON.stringify(SMALL_SCENE, null, 2),
    'Sketches/Obsidian drawing.md': obsidianJsonMarkdown(SMALL_SCENE),
    'Sketches/Empty.excalidraw.md': '',
    'Photos/Nebula logo.png': await fetchBlob('/sketches/workspace/assets/nebula-logo.png'),
    'Photos/Winter hexagon.svg': await hostileSvg(),
    'Photos/Moonrise timelapse.webm': await fetchBlob('/e2e/harness/views-media/moonrise.webm'),
    'Photos/Moonrise timelapse.mp4': await fetchBlob('/e2e/harness/views-media/moonrise.mp4'),
    'Charts/Star chart — October.pdf': makePdf(),
    'Field recordings/Crickets at dusk.wav': makeWav(),
    'Charts/Meteor showers 2026.csv': 'shower,peak,rate\nOrionids,2026-10-21,20\nLeonids,2026-11-17,15\nGeminids,2026-12-14,120\n',
    'src/sky.ts': `// Dark adaptation, in seconds.\nexport const DARK_ADAPTATION = 20 * 60;\n\nexport function isDarkEnough(sunAltitude: number): boolean {\n  return sunAltitude < -18; // astronomical twilight\n}\n`,
    'Archive/backup.zip': new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])]),
    'Broken/unreadable.md': 'never read',
  };
}
