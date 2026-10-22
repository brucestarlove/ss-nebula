import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFileStore, type MemoryFileStore } from '../../../../e2e/harness/views-store';
import type { FileEntry, FileKind } from '../../../files/types';
import AudioView from '../audio/AudioView';
import ImageView from '../image/ImageView';
import PdfView from '../pdf/PdfView';
import { click, render, waitFor } from '../testing/render';
import VideoView from '../video/VideoView';

// jsdom has no object URLs: count them instead.
const urls = new Map<string, Blob>();
const revoked: string[] = [];
let next = 0;

function entryFor(path: string, size?: number): FileEntry {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), type: 'file', size, modified: 0 };
}

function blobOf(url: string | null | undefined): Blob | undefined {
  return url ? urls.get(url) : undefined;
}

describe('media views', () => {
  let store: MemoryFileStore;

  beforeEach(() => {
    urls.clear();
    revoked.length = 0;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      next += 1;
      const url = `blob:nebula/${next}`;
      urls.set(url, blob);
      return url;
    });
    URL.revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url);
    });
    store = createMemoryFileStore({
      'Photos/Nebula logo.png': new Blob([new Uint8Array(2400)]),
      'Photos/Winter hexagon.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
      'Charts/Star chart.pdf': '%PDF-1.4 fake',
      'Field recordings/Crickets.wav': new Blob([new Uint8Array(64)]),
      'Photos/Moonrise.webm': new Blob([new Uint8Array(64)]),
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  async function open(path: string, kind: FileKind, onStatus = vi.fn()) {
    const View = { image: ImageView, pdf: PdfView, audio: AudioView, video: VideoView }[kind as 'image'];
    const entry = entryFor(path, store.peek(path)?.length);
    const view = await render(<View projectId="p" store={store} entry={entry} kind={kind} onStatus={onStatus} />);
    return { view, onStatus };
  }

  describe('ImageView', () => {
    it('shows the image from a blob typed by its name, with its pixel and file size', async () => {
      const { view, onStatus } = await open('Photos/Nebula logo.png', 'image');
      await waitFor(() => expect(view.container.querySelector('img')).not.toBeNull());
      const img = view.container.querySelector('img')!;
      expect(blobOf(img.getAttribute('src'))?.type).toBe('image/png');
      Object.defineProperty(img, 'naturalWidth', { value: 1200 });
      Object.defineProperty(img, 'naturalHeight', { value: 800 });
      await act(async () => {
        img.dispatchEvent(new Event('load'));
      });
      expect(onStatus).toHaveBeenLastCalledWith('1,200 \u00d7 800 px \u00b7 2.4 KB');
      await view.unmount();
      expect(revoked).toContain(img.getAttribute('src'));
    });

    it('shows an SVG only as an image, and lets go of its URL once drawn', async () => {
      const { view } = await open('Photos/Winter hexagon.svg', 'image');
      await waitFor(() => expect(view.container.querySelector('img')).not.toBeNull());
      expect(view.container.querySelector('iframe, object, embed, svg script')).toBeNull();
      const img = view.container.querySelector('img')!;
      const url = img.getAttribute('src');
      expect(blobOf(url)?.type).toBe('image/svg+xml');
      await act(async () => {
        img.dispatchEvent(new Event('load'));
      });
      // Opening the image in a new tab can't turn it into a page of this origin.
      expect(revoked).toContain(url);
      await view.unmount();
    });

    it('zooms with its buttons and goes back to fit', async () => {
      const { view } = await open('Photos/Nebula logo.png', 'image');
      await waitFor(() => expect(view.container.querySelector('img')).not.toBeNull());
      const zoom = () => view.container.querySelector('[data-zoom-level]')?.textContent;
      expect(zoom()).toBe('100%');
      await click(view.container.querySelector('button[aria-label="Zoom in"]'));
      expect(zoom()).toBe('125%');
      await click(view.container.querySelector('button[aria-label="Zoom out"]'));
      await click(view.container.querySelector('button[aria-label="Zoom out"]'));
      expect(zoom()).toBe('80%');
      await click(view.container.querySelector('button[aria-label="Fit to view"]'));
      expect(zoom()).toBe('100%');
      await view.unmount();
    });
  });

  describe('PdfView', () => {
    it('hands the PDF to the browser\u2019s viewer, with Open in new tab and Download', async () => {
      const { view, onStatus } = await open('Charts/Star chart.pdf', 'pdf');
      await waitFor(() => expect(view.container.querySelector('iframe')).not.toBeNull());
      const frame = view.container.querySelector('iframe')!;
      expect(blobOf(frame.getAttribute('src'))?.type).toBe('application/pdf');
      expect(frame.getAttribute('title')).toBe('Star chart.pdf');
      const tab = [...view.container.querySelectorAll('a')].find((link) => /Open in new tab/.test(link.textContent ?? ''));
      expect(tab?.getAttribute('href')).toBe(frame.getAttribute('src'));
      expect(tab?.getAttribute('target')).toBe('_blank');
      expect(tab?.getAttribute('rel')).toBe('noopener noreferrer');
      expect([...view.container.querySelectorAll('button')].some((button) => /Download/.test(button.textContent ?? ''))).toBe(true);
      await waitFor(() => expect(onStatus).toHaveBeenLastCalledWith('13 B'));
      await view.unmount();
      expect(revoked).toContain(frame.getAttribute('src'));
    });
  });

  describe('AudioView and VideoView', () => {
    it.each([
      ['audio', 'Field recordings/Crickets.wav', 'audio/wav'],
      ['video', 'Photos/Moonrise.webm', 'video/webm'],
    ] as const)('plays %s with native controls and reports its duration', async (kind, path, type) => {
      const { view, onStatus } = await open(path, kind);
      await waitFor(() => expect(view.container.querySelector(kind)).not.toBeNull());
      const media = view.container.querySelector<HTMLMediaElement>(kind)!;
      expect(media.hasAttribute('controls')).toBe(true);
      expect(blobOf(media.getAttribute('src'))?.type).toBe(type);
      expect(media.closest('.ws-media')).not.toBeNull();
      Object.defineProperty(media, 'duration', { value: 83.4 });
      await act(async () => {
        media.dispatchEvent(new Event('loadedmetadata'));
      });
      expect(onStatus).toHaveBeenLastCalledWith('1:23');
      await view.unmount();
      expect(revoked).toContain(media.getAttribute('src'));
    });
  });

  it('shows the info card when the file cannot be read', async () => {
    store.unreadable.add('Photos/Nebula logo.png');
    const { view } = await open('Photos/Nebula logo.png', 'image');
    await waitFor(() => expect(view.container.querySelector('.ws-info-card')).not.toBeNull());
    expect(view.container.textContent).toMatch(/couldn.t open this file/);
    await view.unmount();
  });
});
