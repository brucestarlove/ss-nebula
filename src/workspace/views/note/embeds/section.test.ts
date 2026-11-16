import { describe, expect, it } from 'vitest';
import { sectionOf } from './section';

const body = [
  'Intro line.',
  '',
  '## Stars',
  '',
  'Betelgeuse and Rigel.',
  '',
  '### Rigel',
  '',
  'Blue supergiant. ^rigel',
  '',
  'More about it.',
  '',
  '## The Nebula',
  '',
  '```',
  '## Not a heading',
  '```',
  '',
  'M42.',
  '',
  '# Sources',
  '',
  'NASA.',
].join('\n');

describe('sectionOf', () => {
  it('takes a heading and what is under it, up to the next heading of the same level or above', () => {
    expect(sectionOf(body, { heading: 'Stars', block: null })).toBe(
      ['## Stars', '', 'Betelgeuse and Rigel.', '', '### Rigel', '', 'Blue supergiant. ^rigel', '', 'More about it.', ''].join('\n'),
    );
    expect(sectionOf(body, { heading: 'Rigel', block: null })).toBe(['### Rigel', '', 'Blue supergiant. ^rigel', '', 'More about it.', ''].join('\n'));
  });
  it('ignores case, and a heading’s marks', () => {
    expect(sectionOf('## The **Nebula**\n\nM42.\n', { heading: 'the nebula', block: null })).toBe('## The **Nebula**\n\nM42.\n');
  });
  it('does not take a # line inside a fence for a heading', () => {
    expect(sectionOf(body, { heading: 'The Nebula', block: null })).toContain('## Not a heading');
    expect(sectionOf(body, { heading: 'Not a heading', block: null })).toBeNull();
  });
  it('follows a nested heading, and wants it under the first', () => {
    expect(sectionOf(body, { heading: 'Stars#Rigel', block: null })).toContain('Blue supergiant.');
    expect(sectionOf(body, { heading: 'Sources#Rigel', block: null })).toBeNull();
  });
  it('takes the paragraph a block id ends, without the id', () => {
    expect(sectionOf(body, { heading: null, block: 'rigel' })).toBe('Blue supergiant.');
    expect(sectionOf('First line\nsecond line ^abc\n\nOther.', { heading: null, block: 'abc' })).toBe('First line\nsecond line');
  });
  it('is null for nothing asked, and for a part that is not there', () => {
    expect(sectionOf(body, { heading: null, block: null })).toBeNull();
    expect(sectionOf(body, { heading: 'Nope', block: null })).toBeNull();
    expect(sectionOf(body, { heading: null, block: 'nope' })).toBeNull();
  });
});
