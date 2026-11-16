import { describe, expect, it } from 'vitest';
import { InvalidPathError } from '../files/paths';
import { keptCopyText } from './keptCopyText';

const scope = 'night-sky';
const refused = (error: unknown) => ({
  scope,
  path: 'Guides/Observing plan.md',
  copy: null,
  error,
  download: { filename: 'Observing plan (conflict 2026-10-22 11.40).md', text: 'Mine.' },
  release: () => {},
});

describe('keptCopyText', () => {
  it('says where a change was kept', () => {
    expect(keptCopyText({ scope, path: 'Guides/Observing plan.md', copy: 'Guides/Observing plan (conflict 2026-10-22 11.40).md' })).toBe(
      'Your changes to Observing plan were kept as ‘Observing plan (conflict 2026-10-22 11.40)’.',
    );
    expect(keptCopyText({ scope, path: 'Orion.md', copy: 'Orion (conflict 2026-10-22 11.40).md', deleted: true })).toBe(
      'Orion was deleted in another tab. Your changes were kept as ‘Orion (conflict 2026-10-22 11.40)’.',
    );
  });

  it('says in plain words why a copy couldn’t be kept, where the cause is known', () => {
    const full = Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
    expect(keptCopyText(refused(full))).toBe('Couldn’t keep your changes to Observing plan as a copy: this browser’s storage is full. Download them so they aren’t lost.');
    expect(keptCopyText(refused(new DOMException('The quota has been exceeded.', 'QuotaExceededError')))).toBe(
      'Couldn’t keep your changes to Observing plan as a copy: this browser’s storage is full. Download them so they aren’t lost.',
    );
    const long = new InvalidPathError('Guides/x.md', 'segment longer than 255 bytes');
    expect(keptCopyText(refused(long))).toBe('Couldn’t keep your changes to Observing plan as a copy: its name is too long. Download them so they aren’t lost.');
    expect(keptCopyText(refused(new DOMException('Denied.', 'NotAllowedError')))).toBe(
      'Couldn’t keep your changes to Observing plan as a copy: this browser won’t let Nebula save here. Download them so they aren’t lost.',
    );
  });

  it('gives any other cause in its own words', () => {
    expect(keptCopyText(refused(new Error('The operation failed for an unknown transient reason.')))).toBe(
      'Couldn’t keep your changes to Observing plan as a copy (The operation failed for an unknown transient reason). Download them so they aren’t lost.',
    );
  });

  it('says a failed save is a failed save, not a copy that couldn’t be kept', () => {
    const failed = (error: unknown) => ({ ...refused(error), download: { filename: 'Observing plan.md', text: 'Mine.' }, failedSave: true as const });
    const full = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    expect(keptCopyText(failed(full))).toBe('Couldn’t save your changes to Observing plan: this browser’s storage is full. Download them so they aren’t lost.');
    expect(keptCopyText(failed(new Error('The operation failed for an unknown transient reason.')))).toBe(
      'Couldn’t save your changes to Observing plan (The operation failed for an unknown transient reason). Download them so they aren’t lost.',
    );
  });
});
