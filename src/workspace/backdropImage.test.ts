import { describe, expect, it, vi } from 'vitest';
import { BackdropImageError, MAX_BACKDROP_BYTES, prepareBackdropImage, type BackdropTools, type BitmapLike } from './backdropImage';

const PREVIEW = 'data:image/jpeg;base64,/9j/4AAQ';

function tools(width: number, height: number, overrides: Partial<BackdropTools> = {}) {
  const bitmap: BitmapLike = { width, height, close: vi.fn() };
  const kit = {
    decode: vi.fn(async () => bitmap),
    scale: vi.fn(async () => new Blob(['scaled'], { type: 'image/jpeg' })),
    preview: vi.fn(() => PREVIEW),
    ...overrides,
  };
  return { kit, bitmap };
}

describe('prepareBackdropImage', () => {
  it('keeps an image that is small enough as it is, with a preview 40 px on its long side', async () => {
    const { kit, bitmap } = tools(1600, 900);
    const file = new File(['png'], 'Orion.PNG', { type: 'image/png' });
    expect(await prepareBackdropImage(file, { fill: '#000000', tools: kit })).toEqual({ blob: file, ext: 'png', thumb: PREVIEW });
    expect(kit.scale).not.toHaveBeenCalled();
    expect(kit.preview).toHaveBeenCalledWith(bitmap, 40, 23, '#000000');
    expect(bitmap.close).toHaveBeenCalled();
  });

  it('scales one longer than 3200 px down to 3200 on its long side, as a JPEG over the colour', async () => {
    const { kit, bitmap } = tools(4000, 6000);
    const out = await prepareBackdropImage(new File(['x'], 'tall.webp', { type: 'image/webp' }), { fill: '#ffffff', tools: kit });
    expect(kit.scale).toHaveBeenCalledWith(bitmap, 2133, 3200, '#ffffff');
    expect(out.ext).toBe('jpg');
    expect(out.blob.type).toBe('image/jpeg');
  });

  it('makes a JPEG of a format other browsers may not open, at its own size', async () => {
    const { kit, bitmap } = tools(1200, 800);
    const out = await prepareBackdropImage(new File(['x'], 'IMG_0042.HEIC', { type: 'image/heic' }), { fill: '#000000', tools: kit });
    expect(kit.scale).toHaveBeenCalledWith(bitmap, 1200, 800, '#000000');
    expect(out.ext).toBe('jpg');
  });

  it('refuses a file over 50 MB before reading it', async () => {
    const { kit } = tools(10, 10);
    const big = { name: 'huge.png', type: 'image/png', size: MAX_BACKDROP_BYTES + 1 } as File;
    await expect(prepareBackdropImage(big, { fill: '#000000', tools: kit })).rejects.toThrow(new BackdropImageError('That image is over 50 MB.'));
    expect(kit.decode).not.toHaveBeenCalled();
  });

  it("says so when the browser can't open the image", async () => {
    const { kit } = tools(10, 10, {
      decode: vi.fn(async () => {
        throw new DOMException('The source image could not be decoded.', 'InvalidStateError');
      }),
    });
    await expect(prepareBackdropImage(new File(['x'], 'photo.png', { type: 'image/png' }), { fill: '#000000', tools: kit })).rejects.toThrow(
      new BackdropImageError('This browser can’t open that image.'),
    );
  });

  it('takes an SVG as it is, with no preview', async () => {
    const { kit } = tools(10, 10);
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'stars.svg', { type: 'image/svg+xml' });
    expect(await prepareBackdropImage(svg, { fill: '#000000', tools: kit })).toEqual({ blob: svg, ext: 'svg', thumb: null });
    expect(kit.decode).not.toHaveBeenCalled();
  });

  it("refuses what isn't an image", async () => {
    const { kit } = tools(10, 10);
    await expect(prepareBackdropImage(new File(['hi'], 'notes.txt', { type: 'text/plain' }), { fill: '#000000', tools: kit })).rejects.toThrow(
      new BackdropImageError('That isn’t an image.'),
    );
  });
});
