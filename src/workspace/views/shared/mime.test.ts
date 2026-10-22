import { describe, expect, it } from 'vitest';
import { mimeFromName, typedBlob } from './mime';

// jsdom's Blob has no text(); FileReader works everywhere.
function readText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe('mimeFromName', () => {
  it('names the types the media views hand to the browser', () => {
    expect(mimeFromName('Pleiades.png')).toBe('image/png');
    expect(mimeFromName('Orion Nebula.JPG')).toBe('image/jpeg');
    expect(mimeFromName('a.jpeg')).toBe('image/jpeg');
    expect(mimeFromName('hexagon.svg')).toBe('image/svg+xml');
    expect(mimeFromName('a.webp')).toBe('image/webp');
    expect(mimeFromName('a.avif')).toBe('image/avif');
    expect(mimeFromName('a.gif')).toBe('image/gif');
    expect(mimeFromName('Star chart.pdf')).toBe('application/pdf');
    expect(mimeFromName('a.mp3')).toBe('audio/mpeg');
    expect(mimeFromName('Crickets at dusk.m4a')).toBe('audio/mp4');
    expect(mimeFromName('a.wav')).toBe('audio/wav');
    expect(mimeFromName('a.flac')).toBe('audio/flac');
    expect(mimeFromName('a.ogg')).toBe('audio/ogg');
    expect(mimeFromName('Moonrise.mp4')).toBe('video/mp4');
    expect(mimeFromName('a.webm')).toBe('video/webm');
    expect(mimeFromName('a.mov')).toBe('video/quicktime');
  });

  it('falls back to opaque bytes for anything else', () => {
    expect(mimeFromName('archive.zip')).toBe('application/octet-stream');
    expect(mimeFromName('page.html')).toBe('application/octet-stream');
    expect(mimeFromName('noextension')).toBe('application/octet-stream');
  });
});

describe('typedBlob', () => {
  it('types the bytes by the file name, never by what the store says', async () => {
    const stored = new Blob(['<script>alert(1)</script>'], { type: 'text/html' });
    const typed = typedBlob(stored, 'chart.pdf');
    expect(typed.type).toBe('application/pdf');
    expect(await readText(typed)).toBe('<script>alert(1)</script>');
  });

  it('can force a download type', () => {
    const typed = typedBlob(new Blob(['x'], { type: 'image/png' }), 'a.png', 'application/octet-stream');
    expect(typed.type).toBe('application/octet-stream');
  });
});
