import { describe, expect, it } from 'vitest';
import { clampScale, fitView, MAX_SCALE, panBy, zoomAt, zoomBy, type View } from './viewport';

const BOX = { width: 800, height: 600 };

describe('fitView', () => {
  it('scales a large image down to fit, centred', () => {
    expect(fitView({ width: 1600, height: 900 }, BOX)).toEqual({ scale: 0.5, x: 0, y: 75 });
  });

  it('never blows a small image up past its own pixels', () => {
    expect(fitView({ width: 200, height: 100 }, BOX)).toEqual({ scale: 1, x: 300, y: 250 });
  });

  it('copes with an image or a box without size yet', () => {
    expect(fitView({ width: 0, height: 0 }, BOX)).toEqual({ scale: 1, x: 400, y: 300 });
    expect(fitView({ width: 100, height: 100 }, { width: 0, height: 0 })).toEqual({ scale: 1, x: -50, y: -50 });
  });
});

describe('zoomAt', () => {
  const view: View = { scale: 1, x: 100, y: 50 };

  it('keeps the point under the cursor still', () => {
    const next = zoomAt(view, 2, { x: 300, y: 250 });
    expect(next.scale).toBe(2);
    // The image pixel under (300, 250) was (200, 200); it still is.
    expect((300 - next.x) / next.scale).toBeCloseTo(200);
    expect((250 - next.y) / next.scale).toBeCloseTo(200);
  });

  it('clamps to the zoom limits', () => {
    expect(zoomAt(view, 1000, { x: 0, y: 0 }).scale).toBe(MAX_SCALE);
    expect(zoomAt(view, 0.0001, { x: 0, y: 0 }).scale).toBe(clampScale(0));
  });

  it('zooms around the centre of the box with the buttons', () => {
    const next = zoomBy(view, 2, BOX);
    expect((400 - next.x) / next.scale).toBeCloseTo((400 - view.x) / view.scale);
    expect((300 - next.y) / next.scale).toBeCloseTo((300 - view.y) / view.scale);
  });
});

describe('panBy', () => {
  it('moves the image with the pointer', () => {
    expect(panBy({ scale: 2, x: 10, y: 20 }, 5, -7)).toEqual({ scale: 2, x: 15, y: 13 });
  });
});
