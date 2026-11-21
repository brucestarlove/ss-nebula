import { describe, expect, it } from 'vitest';
import { countLabel, formatBytes, usageLabel } from './format';

describe('formatBytes', () => {
  it('speaks in B, KB, MB and GB, with one decimal where it helps', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(980)).toBe('980 B');
    expect(formatBytes(612_000)).toBe('612 KB');
    expect(formatBytes(2_134_000)).toBe('2.1 MB');
    expect(formatBytes(12_400_000)).toBe('12 MB');
    expect(formatBytes(3_200_000_000)).toBe('3.2 GB');
  });
});

describe('usage labels', () => {
  it('counts files in words', () => {
    expect(countLabel(1, 'file')).toBe('1 file');
    expect(countLabel(14, 'file')).toBe('14 files');
  });

  it('takes the plural of a noun that does not add a plain s', () => {
    expect(countLabel(1, 'canvas', 'canvases')).toBe('1 canvas');
    expect(countLabel(2, 'canvas', 'canvases')).toBe('2 canvases');
    expect(countLabel(0, 'canvas', 'canvases')).toBe('0 canvases');
  });

  it('says how many files and how much space', () => {
    expect(usageLabel([{ path: 'a', name: 'a', type: 'file', size: 1_500_000 }, { path: 'b', name: 'b', type: 'dir' }])).toBe(
      '1 file · 1.5 MB',
    );
  });
});
