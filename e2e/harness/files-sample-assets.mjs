// Regenerates the Night Sky sample's binary files in public/sample/ (see
// public/sample/CREDITS.md). Run from the repository root:
//
//   node e2e/harness/files-sample-assets.mjs
//
// It renders the winter hexagon sketch to a PNG, and sets a star chart in HTML
// and prints it to PDF with Playwright's Chromium. Star positions (ICRS, epoch
// J2000) and V magnitudes are from SIMBAD (CDS), queried 2026-10-22.
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const out = (name) => resolve('public/sample', name);

// SIMBAD TAP, 2026-10-22: SELECT main_id, ra, dec, V FROM basic JOIN allfluxes …
const STARS = [
  { name: 'Sirius', id: 'alf CMa', ra: 101.28715533333335, dec: -16.71611586111111, v: -1.46 },
  { name: 'Capella', id: 'alf Aur', ra: 79.17232794433404, dec: 45.99799146983673, v: 0.08 },
  { name: 'Rigel', id: 'bet Ori', ra: 78.63446706693006, dec: -8.201638364722209, v: 0.13 },
  { name: 'Procyon', id: 'alf CMi', ra: 114.82549790798149, dec: 5.224987557059477, v: 0.37 },
  { name: 'Betelgeuse', id: 'alf Ori', ra: 88.79293899077537, dec: 7.407063995272694, v: 0.42 },
  { name: 'Aldebaran', id: 'alf Tau', ra: 68.9801627900154, dec: 16.5093023507718, v: 0.86 },
  { name: 'Pollux', id: 'bet Gem', ra: 116.32895777437875, dec: 28.02619889009357, v: 1.14 },
  { name: 'Castor', id: 'alf Gem', ra: 113.64947163976585, dec: 31.88828221646326, v: 1.58 },
  { name: 'Bellatrix', id: 'gam Ori', ra: 81.28276355652378, dec: 6.3497032644440665, v: 1.64 },
  { name: 'Alnilam', id: 'eps Ori', ra: 84.05338894077023, dec: -1.2019191358333312, v: 1.69 },
  { name: 'Alnitak', id: 'zet Ori', ra: 85.18969442793068, dec: -1.9425735859722049, v: 1.77 },
  { name: 'Saiph', id: 'kap Ori', ra: 86.93912016833333, dec: -9.66960491861111, v: 2.06 },
  { name: 'Mintaka', id: 'del Ori', ra: 83.00166705557675, dec: -0.29909510708333326, v: 2.41 },
];
const DEEP_SKY = [
  { name: 'M42', label: 'Orion Nebula', ra: 83.8201, dec: -5.3876, kind: 'nebula' },
  { name: 'M45', label: 'Pleiades', ra: 56.600833333333334, dec: 24.11388888888889, kind: 'cluster' },
];
const HEXAGON = ['Rigel', 'Aldebaran', 'Capella', 'Pollux', 'Procyon', 'Sirius'];
const ORION = [
  ['Betelgeuse', 'Bellatrix'],
  ['Betelgeuse', 'Alnitak'],
  ['Bellatrix', 'Mintaka'],
  ['Mintaka', 'Alnilam'],
  ['Alnilam', 'Alnitak'],
  ['Alnitak', 'Saiph'],
  ['Mintaka', 'Rigel'],
];
const CONSTELLATIONS = [
  { name: 'ORION', ra: 92.5, dec: 2.5 },
  { name: 'TAURUS', ra: 66, dec: 9.5 },
  { name: 'AURIGA', ra: 84, dec: 41 },
  { name: 'GEMINI', ra: 106, dec: 24 },
  { name: 'CANIS MINOR', ra: 113.5, dec: 0 },
  { name: 'CANIS MAJOR', ra: 99, dec: -21.5 },
];

// The chart: RA 3h20m to 8h20m, Dec −24° to +52°. East (larger RA) on the
// left, as the sky looks facing south; RA squeezed by cos(15°).
const RA_MIN = 50;
const RA_MAX = 125;
const DEC_MIN = -24;
const DEC_MAX = 52;
const SCALE = 9.4;
const SQUEEZE = Math.cos((15 * Math.PI) / 180);
const WIDTH = (RA_MAX - RA_MIN) * SQUEEZE * SCALE;
const HEIGHT = (DEC_MAX - DEC_MIN) * SCALE;
const x = (ra) => (RA_MAX - ra) * SQUEEZE * SCALE;
const y = (dec) => (DEC_MAX - dec) * SCALE;
const radius = (v) => Math.max(1.8, 6.4 - 1.75 * v);
const star = (name) => STARS.find((candidate) => candidate.name === name);
const f = (n) => n.toFixed(1);

function chartSvg() {
  const parts = [];
  for (let ra = 60; ra <= 120; ra += 15) {
    parts.push(`<line class="grid" x1="${f(x(ra))}" y1="0" x2="${f(x(ra))}" y2="${f(HEIGHT)}"/>`);
    parts.push(`<text class="tick" x="${f(x(ra))}" y="${f(HEIGHT + 16)}" text-anchor="middle">${ra / 15}h</text>`);
  }
  for (let dec = -20; dec <= 50; dec += 10) {
    parts.push(`<line class="grid${dec === 0 ? ' equator' : ''}" x1="0" y1="${f(y(dec))}" x2="${f(WIDTH)}" y2="${f(y(dec))}"/>`);
    parts.push(`<text class="tick" x="${f(WIDTH + 8)}" y="${f(y(dec) + 4)}">${dec > 0 ? '+' : dec < 0 ? '−' : ''}${Math.abs(dec)}°</text>`);
  }
  const hexagon = HEXAGON.map((name) => `${f(x(star(name).ra))},${f(y(star(name).dec))}`).join(' ');
  parts.push(`<polygon class="hexagon" points="${hexagon}"/>`);
  for (const [a, b] of ORION) {
    parts.push(`<line class="figure" x1="${f(x(star(a).ra))}" y1="${f(y(star(a).dec))}" x2="${f(x(star(b).ra))}" y2="${f(y(star(b).dec))}"/>`);
  }
  for (const constellation of CONSTELLATIONS) {
    parts.push(`<text class="constellation" x="${f(x(constellation.ra))}" y="${f(y(constellation.dec))}" text-anchor="middle">${constellation.name}</text>`);
  }
  for (const object of DEEP_SKY) {
    const cx = x(object.ra);
    const cy = y(object.dec);
    parts.push(
      object.kind === 'nebula'
        ? `<ellipse class="nebula" cx="${f(cx)}" cy="${f(cy)}" rx="9" ry="6.5"/>`
        : `<circle class="cluster" cx="${f(cx)}" cy="${f(cy)}" r="8"/>`,
    );
    const right = object.kind === 'nebula';
    parts.push(`<text class="deep" x="${f(cx + (right ? 14 : -12))}" y="${f(cy + 4)}" text-anchor="${right ? 'start' : 'end'}">${object.name} ${object.label}</text>`);
  }
  const labelSide = { Betelgeuse: 'end', Bellatrix: 'start', Alnilam: 'above', Alnitak: 'end', Mintaka: 'start', Saiph: 'end', Castor: 'end' };
  for (const entry of STARS) {
    const cx = x(entry.ra);
    const cy = y(entry.dec);
    parts.push(`<circle class="star" cx="${f(cx)}" cy="${f(cy)}" r="${f(radius(entry.v))}"/>`);
    const side = labelSide[entry.name] ?? 'start';
    const small = entry.v > 1.5 ? ' small' : '';
    if (side === 'above') {
      parts.push(`<text class="label${small}" x="${f(cx + 2)}" y="${f(cy - radius(entry.v) - 7)}" text-anchor="end">${entry.name}</text>`);
      continue;
    }
    const dx = (radius(entry.v) + 5) * (side === 'end' ? -1 : 1);
    parts.push(`<text class="label${small}" x="${f(cx + dx)}" y="${f(cy + 4)}" text-anchor="${side}">${entry.name}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-6 -6 ${f(WIDTH + 52)} ${f(HEIGHT + 30)}" width="${f(WIDTH + 58)}" height="${f(HEIGHT + 36)}">${parts.join('')}</svg>`;
}

function legendSvg() {
  const items = [-1, 0, 1, 2].map((v, index) => {
    const cx = 10 + index * 52;
    return `<circle class="star" cx="${cx}" cy="12" r="${f(radius(v))}"/><text class="tick" x="${cx}" y="40" text-anchor="middle">${v < 0 ? '−' : ''}${Math.abs(v)}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="190" height="46" viewBox="0 0 190 46">${items.join('')}</svg>`;
}

function chartHtml() {
  const font = readFileSync(resolve('sketches/workspace/fonts/mona-sans.woff2')).toString('base64');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Star chart — October: Orion and the winter hexagon</title><style>
  @font-face { font-family: 'Mona Sans'; src: url(data:font/woff2;base64,${font}) format('woff2'); font-weight: 200 900; }
  @page { size: A4 landscape; margin: 0; }
  html, body { margin: 0; background: #0e1430; color: #e8ecff; font-family: 'Mona Sans', sans-serif; }
  main { box-sizing: border-box; width: 297mm; height: 210mm; padding: 13mm 12mm; display: flex; gap: 9mm; align-items: center; }
  aside { width: 70mm; flex: none; }
  h1 { font-size: 21pt; font-weight: 640; line-height: 1.1; margin: 0 0 3mm; letter-spacing: -0.01em; }
  .kicker { font-size: 9pt; letter-spacing: 0.14em; text-transform: uppercase; color: #9aa6ff; margin: 0 0 2mm; }
  p { font-size: 9.5pt; line-height: 1.45; color: #c9d0f2; margin: 0 0 3mm; }
  .legend { margin-top: 6mm; }
  .legend h2 { font-size: 8.5pt; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: #9aa6ff; margin: 0 0 2mm; }
  .key { display: flex; align-items: center; gap: 3mm; font-size: 9pt; color: #c9d0f2; margin: 1.5mm 0; }
  .swatch { width: 12mm; height: 0; border-top: 1.4px dashed #7c8cff; }
  .swatch.figure { border-top: 1px solid #5d6aa8; }
  .source { margin-top: 8mm; font-size: 7.5pt; color: #8d97c4; }
  svg text { font-family: 'Mona Sans', sans-serif; }
  .grid { stroke: #2a3566; stroke-width: 0.6; }
  .equator { stroke: #3c4a8a; stroke-dasharray: 3 3; }
  .tick { fill: #7f8abb; font-size: 9px; }
  .hexagon { fill: rgba(124, 140, 255, 0.06); stroke: #7c8cff; stroke-width: 1.4; stroke-dasharray: 6 4; }
  .figure { stroke: #5d6aa8; stroke-width: 1; }
  .star { fill: #ffffff; }
  .label { fill: #e8ecff; font-size: 11.5px; font-weight: 560; }
  .label.small { font-size: 9.5px; font-weight: 450; fill: #c9d0f2; }
  .constellation { fill: #6f7cc0; font-size: 10px; letter-spacing: 0.18em; font-weight: 600; }
  .nebula { fill: rgba(176, 190, 255, 0.28); stroke: #b0beff; stroke-width: 0.8; }
  .cluster { fill: none; stroke: #b0beff; stroke-width: 0.9; stroke-dasharray: 2 2; }
  .deep { fill: #b0beff; font-size: 9.5px; font-style: italic; }
</style></head><body><main>
  <aside>
    <p class="kicker">Night Sky · Star chart</p>
    <h1>Orion and the winter hexagon</h1>
    <p>Six bright stars make the hexagon: Rigel, Aldebaran, Capella, Pollux, Procyon and Sirius. Betelgeuse sits inside it.</p>
    <p>Follow Orion’s Belt one way to Sirius, the brightest star in the night sky, and the other way to Aldebaran and the Pleiades.</p>
    <p>North is up and east is to the left, as the sky looks when you face south.</p>
    <div class="legend">
      <h2>Brightness (magnitude)</h2>
      ${legendSvg()}
      <div class="key"><span class="swatch"></span>Winter hexagon</div>
      <div class="key"><span class="swatch figure"></span>Orion</div>
    </div>
    <p class="source">Star positions (ICRS, epoch J2000) and magnitudes: SIMBAD, CDS, Strasbourg. Made for Nebula’s Night Sky sample.</p>
  </aside>
  ${chartSvg()}
</main></body></html>`;
}

const browser = await chromium.launch();
try {
  // The night export is light ink on nothing: give it the chart's night sky.
  const svg = readFileSync(resolve('sketches/workspace/assets/winter-hexagon-night.svg')).toString('base64');
  const sketch = await browser.newPage({ viewport: { width: 1106, height: 781 }, deviceScaleFactor: 1 });
  await sketch.setContent(
    `<!doctype html><html><body style="margin:0;background:#0e1430"><img alt="" width="1106" height="781" style="display:block" src="data:image/svg+xml;base64,${svg}"></body></html>`,
    { waitUntil: 'load' },
  );
  await sketch.waitForTimeout(300);
  writeFileSync(out('winter-hexagon.png'), await sketch.screenshot({ type: 'png' }));

  const chart = await browser.newPage();
  await chart.setContent(chartHtml(), { waitUntil: 'load' });
  await chart.evaluate(() => document.fonts.ready);
  writeFileSync(out('star-chart.pdf'), await chart.pdf({ format: 'A4', landscape: true, printBackground: true }));
  await chart.setViewportSize({ width: 1123, height: 794 });
  await chart.screenshot({ path: resolve(process.env.TMPDIR ?? '/tmp', 'files-star-chart.png') });
} finally {
  await browser.close();
}
console.log('Wrote public/sample/winter-hexagon.png and public/sample/star-chart.pdf');
