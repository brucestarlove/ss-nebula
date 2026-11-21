import { describe, expect, it } from 'vitest';
import type { Actor } from '../../../files/types';
import {
  countLines,
  folderOf,
  formatBytes,
  formatCount,
  formatDuration,
  formatActor,
  formatEdited,
  isYou,
  kindLabel,
  titleFromName,
} from './format';

describe('formatBytes', () => {
  it('counts small files in bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(999)).toBe('999 B');
  });

  it('uses one decimal below ten units and none above, in powers of 1000', () => {
    expect(formatBytes(1500)).toBe('1.5 KB');
    expect(formatBytes(820_000)).toBe('820 KB');
    expect(formatBytes(1_200_000)).toBe('1.2 MB');
    expect(formatBytes(12_340_000)).toBe('12 MB');
    expect(formatBytes(3_100_000_000)).toBe('3.1 GB');
  });

  it('says nothing for an unknown size', () => {
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(Number.NaN)).toBe('');
  });
});

describe('formatDuration', () => {
  it('shows minutes and seconds, and hours when there are any', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(5.4)).toBe('0:05');
    expect(formatDuration(204)).toBe('3:24');
    expect(formatDuration(3723)).toBe('1:02:03');
  });

  it('says nothing for a stream with no known length', () => {
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
  });
});

describe('formatCount', () => {
  it('pluralises and groups thousands', () => {
    expect(formatCount(0, 'word')).toBe('0 words');
    expect(formatCount(1, 'word')).toBe('1 word');
    expect(formatCount(76, 'word')).toBe('76 words');
    expect(formatCount(1204, 'word')).toBe('1,204 words');
    expect(formatCount(1, 'line')).toBe('1 line');
  });
});

describe('countLines', () => {
  it('counts lines as an editor shows them, without a final empty line', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('one')).toBe(1);
    expect(countLines('one\ntwo')).toBe(2);
    expect(countLines('one\ntwo\n')).toBe(2);
    expect(countLines('one\r\ntwo\r\n\r\n')).toBe(3);
  });
});

describe('formatEdited', () => {
  const now = Date.UTC(2026, 9, 22, 12, 0, 0);

  it('reads like the sketch for recent edits', () => {
    expect(formatEdited(now - 20_000, now)).toBe('Edited just now');
    expect(formatEdited(now - 4 * 60_000, now)).toBe('Edited 4 min ago');
    expect(formatEdited(now - 60 * 60_000, now)).toBe('Edited 1 hour ago');
    expect(formatEdited(now - 5 * 60 * 60_000, now)).toBe('Edited 5 hours ago');
  });

  it('switches to days, then to a date', () => {
    expect(formatEdited(now - 26 * 60 * 60_000, now)).toBe('Edited yesterday');
    expect(formatEdited(now - 3 * 24 * 60 * 60_000, now)).toBe('Edited 3 days ago');
    expect(formatEdited(Date.UTC(2026, 6, 4, 12), now)).toMatch(/^Edited 4 Jul$/);
    expect(formatEdited(Date.UTC(2024, 0, 15, 12), now)).toMatch(/^Edited 15 Jan 2024$/);
  });

  it('treats a clock slightly ahead as just now, and says nothing without a time', () => {
    expect(formatEdited(now + 5_000, now)).toBe('Edited just now');
    expect(formatEdited(undefined, now)).toBe('');
  });
});

describe('formatEdited with who made the change', () => {
  const now = Date.UTC(2026, 9, 22, 12, 0, 0);
  const lear: Actor = { type: 'agent', id: 'lear', name: 'Lear' };
  const bruce: Actor = { type: 'human', id: 'u-1', name: 'Bruce' };

  it('names the actor before the time, in each of the time’s forms', () => {
    expect(formatEdited(now - 4 * 60_000, now, lear)).toBe('Edited by Lear, 4 min ago');
    expect(formatEdited(now - 26 * 60 * 60_000, now, lear)).toBe('Edited by Lear, yesterday');
    expect(formatEdited(Date.UTC(2026, 6, 4, 12), now, lear)).toBe('Edited by Lear, 4 Jul');
  });

  it('says you when type and id both match the asker', () => {
    expect(formatEdited(now - 4 * 60_000, now, bruce, { ...bruce })).toBe('Edited by you, 4 min ago');
    // the same id from the other kind of actor is someone else, and a different id is too
    expect(formatEdited(now - 4 * 60_000, now, { ...bruce, type: 'agent' }, bruce)).toBe('Edited by Bruce, 4 min ago');
    expect(formatEdited(now - 4 * 60_000, now, bruce, { ...bruce, id: 'u-2' })).toBe('Edited by Bruce, 4 min ago');
    expect(formatEdited(now - 4 * 60_000, now, bruce, undefined)).toBe('Edited by Bruce, 4 min ago');
  });

  it('falls back to the actor’s id when it has no name', () => {
    expect(formatEdited(now - 4 * 60_000, now, { type: 'agent', id: 'corona', name: '' })).toBe('Edited by corona, 4 min ago');
  });

  it('keeps the existing line with no actor, and says nothing with no time even with one', () => {
    expect(formatEdited(now - 4 * 60_000, now)).toBe('Edited 4 min ago');
    expect(formatEdited(now - 4 * 60_000, now, undefined, bruce)).toBe('Edited 4 min ago');
    expect(formatEdited(undefined, now, lear, bruce)).toBe('');
  });

  it('isYou needs both an actor and an asker, matching by type and id', () => {
    expect(isYou(bruce, { ...bruce, name: 'Someone else' })).toBe(true);
    expect(isYou(undefined, bruce)).toBe(false);
    expect(isYou(bruce, undefined)).toBe(false);
    expect(isYou(lear, bruce)).toBe(false);
    expect(isYou({ type: 'agent', id: 'u-1', name: 'x' }, bruce)).toBe(false);
  });

  it('formatActor is you, or the name, or the id', () => {
    expect(formatActor(bruce, bruce)).toBe('you');
    expect(formatActor(lear, bruce)).toBe('Lear');
    expect(formatActor({ type: 'agent', id: 'corona', name: '' })).toBe('corona');
  });
});

describe('names', () => {
  it('takes the title from the file name without its extension', () => {
    expect(titleFromName('Observing plan.md')).toBe('Observing plan');
    expect(titleFromName('Winter hexagon.excalidraw.md')).toBe('Winter hexagon');
    expect(titleFromName('Telescope setup.excalidraw')).toBe('Telescope setup');
    expect(titleFromName('v1.2 notes.md')).toBe('v1.2 notes');
    expect(titleFromName('README')).toBe('README');
    expect(titleFromName('.gitignore')).toBe('.gitignore');
  });

  it('finds the folder of a path, empty at the root', () => {
    expect(folderOf('Guides/Observing plan.md')).toBe('Guides');
    expect(folderOf('Guides/Deep sky/Orion.md')).toBe('Guides/Deep sky');
    expect(folderOf('README.md')).toBe('');
  });

  it('labels a file by its extension', () => {
    expect(kindLabel('archive.zip')).toBe('ZIP file');
    expect(kindLabel('model.blend')).toBe('BLEND file');
    expect(kindLabel('noextension')).toBe('File');
  });
});
