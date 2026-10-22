/** Pure geometry for the image view: fit, zoom about a point, pan. */
export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
/** The image drawn at (x, y) in the box, `scale` box pixels per image pixel. */
export type View = { scale: number; x: number; y: number };

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 16;

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** The whole image in the box, centred, never larger than its own pixels. */
export function fitView(image: Size, box: Size): View {
  const sized = image.width > 0 && image.height > 0 && box.width > 0 && box.height > 0;
  const scale = sized ? clampScale(Math.min(1, box.width / image.width, box.height / image.height)) : 1;
  return {
    scale,
    x: (box.width - image.width * scale) / 2,
    y: (box.height - image.height * scale) / 2,
  };
}

/** Zoom by `factor`, keeping the image pixel under `point` where it is. */
export function zoomAt(view: View, factor: number, point: Point): View {
  const scale = clampScale(view.scale * factor);
  const ratio = scale / view.scale;
  return {
    scale,
    x: point.x - (point.x - view.x) * ratio,
    y: point.y - (point.y - view.y) * ratio,
  };
}

/** Zoom about the centre of the box: the + and − buttons. */
export function zoomBy(view: View, factor: number, box: Size): View {
  return zoomAt(view, factor, { x: box.width / 2, y: box.height / 2 });
}

export function panBy(view: View, dx: number, dy: number): View {
  return { scale: view.scale, x: view.x + dx, y: view.y + dy };
}
