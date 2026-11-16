import { afterEach, describe, expect, it } from 'vitest';
import { downloadedLabel, lastDownloaded, recordDownload } from './downloads';

afterEach(() => localStorage.clear());

describe('when a project was last downloaded', () => {
  it('is kept per project, in this browser', () => {
    expect(lastDownloaded('night-sky')).toBeNull();
    recordDownload('night-sky', 1_000);
    recordDownload('pulse', 2_000);
    recordDownload('night-sky', 3_000);
    expect(lastDownloaded('night-sky')).toBe(3_000);
    expect(lastDownloaded('pulse')).toBe(2_000);
    expect(lastDownloaded('elsewhere')).toBeNull();
  });

  it('starts over from what it can’t read, without throwing', () => {
    localStorage.setItem('nebula:downloads', '{"night-sky": "yesterday", "pulse": 5');
    expect(lastDownloaded('night-sky')).toBeNull();
    recordDownload('night-sky', 7_000);
    expect(lastDownloaded('night-sky')).toBe(7_000);
    localStorage.setItem('nebula:downloads', '{"night-sky": "soon", "pulse": 9000}');
    expect(lastDownloaded('night-sky')).toBeNull();
    expect(lastDownloaded('pulse')).toBe(9_000);
  });

  it('works where the browser keeps no localStorage', () => {
    expect(lastDownloaded('night-sky', null)).toBeNull();
    expect(() => recordDownload('night-sky', 1, null)).not.toThrow();
  });
});

describe('downloadedLabel', () => {
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

  it('says when, by the calendar', () => {
    expect(downloadedLabel(null, at(25, 12))).toBe('Not downloaded yet.');
    expect(downloadedLabel(at(25, 9), at(25, 23, 59))).toBe('Last downloaded today.');
    expect(downloadedLabel(at(24, 23, 50), at(25, 0, 10))).toBe('Last downloaded yesterday.');
    expect(downloadedLabel(at(22, 8), at(25, 20))).toBe('Last downloaded 3 days ago.');
  });

  it('says today for a time a little ahead of the clock', () => {
    expect(downloadedLabel(at(25, 12, 5), at(25, 12))).toBe('Last downloaded today.');
  });
});
