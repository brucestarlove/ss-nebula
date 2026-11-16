import { beforeEach, describe, expect, it, vi } from 'vitest';
import { firstFamily, fontFaceCss, forgetFonts } from './canvasFonts';

const woff = (ok = true) => vi.fn(async (url: string) => ({ ok, url, arrayBuffer: async () => new Uint8Array([119, 79, 70, 50]).buffer }) as unknown as Response);

beforeEach(forgetFonts);

describe('firstFamily', () => {
  it('is the first name of a font-family value, unquoted', () => {
    expect(firstFamily('Excalifont, Xiaolai, Segoe UI Emoji')).toBe('Excalifont');
    expect(firstFamily('"Lilita One", cursive')).toBe('Lilita One');
    expect(firstFamily('')).toBe('');
  });
});

describe('fontFaceCss', () => {
  it('embeds the Latin face of each family it knows, from the app’s own fonts folder', async () => {
    const fetcher = woff();
    const css = await fontFaceCss(['Excalifont', 'Virgil', 'Excalifont'], '/', fetcher);
    expect(css.match(/@font-face/g)).toHaveLength(2);
    expect(css).toContain('font-family:"Excalifont"');
    expect(css).toContain('url(data:font/woff2;base64,d09GMg==)');
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual(['/fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2', '/fonts/Virgil/Virgil-Regular.woff2']);
  });

  it('only ever asks this site, whatever the asset path says about slashes', async () => {
    const fetcher = woff();
    await fontFaceCss(['Virgil'], '/nebula', fetcher);
    expect(fetcher).toHaveBeenCalledWith('/nebula/fonts/Virgil/Virgil-Regular.woff2');
  });

  it('leaves a family it does not carry, and a font it cannot read, to the browser', async () => {
    expect(await fontFaceCss(['Xiaolai', 'Papyrus'], '/', woff())).toBe('');
    expect(await fontFaceCss(['Virgil'], '/', woff(false))).toBe('');
    const broken = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await fontFaceCss(['Virgil'], '/', broken)).toBe('');
  });

  it('reads a font once, and tries again after a failure', async () => {
    const fetcher = woff();
    await fontFaceCss(['Virgil'], '/', fetcher);
    await fontFaceCss(['Virgil'], '/', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    forgetFonts();
    const failing = woff(false);
    await fontFaceCss(['Virgil'], '/', failing);
    await fontFaceCss(['Virgil'], '/', failing);
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
