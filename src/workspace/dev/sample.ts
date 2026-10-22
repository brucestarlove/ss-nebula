/** Sample content for the dev registry: Night Sky as the sketch shows it,
 * plus four more projects for the dock and the menus. Lane A ships the real
 * sample project (src/files, public/sample). */

const OBSERVING_PLAN = `---
tags: [stargazing, october]
---
# Observing plan

Saturday, after moonset. The dark site is forty minutes north, past the reservoir, and the forecast says clear until 3 am.

## Targets

- [x] Orion Nebula (M42), low in the east after 11 pm. Notes in [[Orion]].
- [ ] The Pleiades (M45). Binoculars first, then the scope.
- [ ] Andromeda (M31), before it drops into the trees.

![[Winter hexagon.excalidraw]]

## Pack

Red flashlight, the [[Star chart — October.pdf|Star chart — October]], warm layers and a thermos.

> Give your eyes twenty minutes in the dark before you judge the sky.
`;

const ORION = `# Orion

The hunter rises in the east after 11 pm in October. Best from the dark site; see the [[Observing plan]].

## M42

A fuzzy patch below the belt, even in binoculars.
`;

const MOON_PHASES = `# Moon phases

| Phase | Date |
| --- | --- |
| New moon | Oct 21 |
| First quarter | Oct 29 |
| Full moon | Nov 5 |
`;

const README = `# Night Sky

A small sample project. Start with the [[Observing plan]], then the charts.

Delete it whenever you like.
`;

function canvas(title: string): string {
  const scene = {
    type: 'excalidraw',
    version: 2,
    source: 'starscape.nebula',
    elements: [
      {
        id: `${title}-title`,
        type: 'text',
        x: 40,
        y: 40,
        width: 220,
        height: 35,
        angle: 0,
        text: title,
        originalText: title,
        fontSize: 28,
        fontFamily: 5,
        textAlign: 'left',
        verticalAlign: 'top',
        strokeColor: '#1e1e1e',
        backgroundColor: 'transparent',
        version: 1,
        isDeleted: false,
      },
    ],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  };
  return `---

excalidraw-plugin: parsed
tags: [excalidraw]

---

# Excalidraw Data

## Text Elements
${title} ^title

%%
## Drawing
\`\`\`json
${JSON.stringify(scene)}
\`\`\`
%%
`;
}

function bytes(size: number, type: string): Blob {
  return new Blob([new Uint8Array(size)], { type });
}

export type SampleProject = { id: string; name: string; color: string; files: Record<string, string | Blob> };

export function sampleProjects(): SampleProject[] {
  return [
    {
      id: 'night-sky',
      name: 'Night Sky',
      color: '#7c8cff',
      files: {
        'Guides/Observing plan.md': OBSERVING_PLAN,
        'Guides/Orion.md': ORION,
        'Guides/Moon phases.md': MOON_PHASES,
        'Sketches/Winter hexagon.excalidraw.md': canvas('Winter hexagon'),
        'Sketches/Telescope setup.excalidraw.md': canvas('Telescope setup'),
        'Photos/Orion Nebula.jpg': bytes(612_000, 'image/jpeg'),
        'Photos/Pleiades.png': bytes(402_000, 'image/png'),
        'Photos/Moonrise timelapse.mp4': bytes(840_000, 'video/mp4'),
        'Field recordings/Crickets at dusk.m4a': bytes(120_000, 'audio/mp4'),
        'Field recordings/Voice memo, Saturday.m4a': bytes(64_000, 'audio/mp4'),
        'Charts/Star chart — October.pdf': bytes(96_000, 'application/pdf'),
        'Charts/Meteor showers 2026.csv': 'Shower,Peak\nOrionids,Oct 21\nLeonids,Nov 17\nGeminids,Dec 14\n',
        'README.md': README,
        // What the sketch shows open, as the real sample will (lane A).
        '.nebula/workspace.json': JSON.stringify({
          tabs: ['Guides/Observing plan.md', 'Sketches/Winter hexagon.excalidraw.md', 'Photos/Orion Nebula.jpg'],
          active: 'Guides/Observing plan.md',
          expanded: ['Guides', 'Sketches', 'Photos'],
          starred: ['Guides/Observing plan.md', 'Sketches/Winter hexagon.excalidraw.md'],
        }),
      },
    },
    {
      id: 'starscape-biz',
      name: 'Starscape Biz',
      color: '#38d1eb',
      files: {
        'Brief.md': '# Brief\n\nThe site, in one page.\n',
        'Copy.md': '# Copy\n\n## Hero\n\n## Services\n',
        'Site map.excalidraw.md': canvas('Site map'),
        'Media/hero.png': bytes(48_000, 'image/png'),
      },
    },
    {
      id: 'orbit',
      name: 'Orbit',
      color: '#a78bfa',
      files: {
        'Roadmap.md': '# Roadmap\n\n## Now\n\n## Next\n',
        'Board.excalidraw.md': canvas('Board'),
      },
    },
    {
      id: 'pulse',
      name: 'Pulse',
      color: '#f472b6',
      files: { 'Notes.md': '# Notes\n' },
    },
    {
      id: 'earth-village',
      name: 'Earth Village',
      color: '#4ade80',
      files: {
        'Garden plan.md': '# Garden plan\n\n## Beds\n\n## Seeds\n',
        'Seeds.csv': 'Seed,Sown\nKale,Mar 2\nBeans,May 10\n',
      },
    },
  ];
}
