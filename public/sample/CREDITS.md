# Night Sky sample: where the files come from

Nebula fetches these files when it makes the Night Sky sample project (`src/files/sample.ts`). The notes and the canvas are in `src/files/sample/`. Everything here was made for Nebula; nothing is copied from elsewhere.

| File | In the project as | Made from | Licence |
|---|---|---|---|
| `winter-hexagon.png` | Photos/Winter hexagon.png | A render of the sketch `sketches/workspace/assets/winter-hexagon-night.svg`, Nebula's own Excalidraw drawing, on a night-sky background. Rendered with Playwright's Chromium by `e2e/harness/files-sample-assets.mjs`. | AGPL-3.0, like the rest of this repository |
| `star-chart.pdf` | Charts/Star chart — October.pdf | A star chart drawn in HTML and SVG and printed to PDF with Playwright's Chromium (`page.pdf()`) by `e2e/harness/files-sample-assets.mjs`. Star positions (ICRS, epoch J2000) and V magnitudes from SIMBAD (CDS, Strasbourg, <https://simbad.cds.unistra.fr>), queried 2026-10-22; positions and magnitudes are facts, credited here as courtesy. Text set in Mona Sans (SIL Open Font License 1.1, see `sketches/workspace/fonts/LICENSE-mona-sans.txt`), embedded as a subset, as that licence allows. | AGPL-3.0, like the rest of this repository |

The facts in the notes come from:

- NASA Science, "Moon Phases": <https://science.nasa.gov/moon/moon-phases/>
- NASA Science, "Messier 42": <https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-42/>
- NASA Science, "Discovering the Universe Through the Constellation Orion": <https://science.nasa.gov/universe/stories/quick-reads/discovering-the-universe-through-the-constellation-orion/>
- NASA Science, "What's Up: December 2024": <https://science.nasa.gov/solar-system/skywatching/whats-up-december-2024-skywatching-tips-from-nasa/>
- NASA Science, "Connecting the 'Dots' with Asterisms" (the winter hexagon's six stars): <https://science.nasa.gov/solar-system/skywatching/night-sky-network/connecting-the-dots-with-asterisms>
- EarthSky, "Use Orion's Belt to find 4 bright stars in the sky": <https://earthsky.org/sky-archive/use-orions-belt-to-find-two-other-stars-2006>

All checked 2026-10-22. The observing plan is a story (whose Saturday, which dark site), not a forecast.

To make the PNG and the PDF again: `node e2e/harness/files-sample-assets.mjs` from the repository root.
