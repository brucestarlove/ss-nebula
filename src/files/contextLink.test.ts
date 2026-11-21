// The app's rule for an Orbit card's link must be the server's: a value the server would refuse
// is never sent, and one it accepts is never dropped. The server's own rule is read from
// cli/nebula-files.mjs, so a change to either side fails here.
import { describe, expect, it } from 'vitest';
import serverSource from '../../cli/nebula-files.mjs?raw';
import { isContextLink, MAX_CONTEXT } from './contextLink';

const found = /^const CONTEXT = \/(.+)\/$/m.exec(serverSource);
if (!found) throw new Error('cli/nebula-files.mjs no longer has `const CONTEXT = /…/`');
const server = new RegExp(found[1]);

const table: Array<[string, unknown]> = [
  ['an Orbit card', 'orbit:card/board-1/12'],
  ['an address', 'https://orbit.test/b/1?card=2#top'],
  ['every character a link may hold', "A-Za-z0-9._~:/?#[]@!$&'()*+,;=%-"],
  ['a percent-encoded value', 'orbit:card/a%20b/1'],
  ['one character', 'x'],
  ['256 characters', `orbit:card/${'x'.repeat(245)}`],
  ['257 characters', `orbit:card/${'x'.repeat(246)}`],
  ['nothing', ''],
  ['a space', 'orbit:card/a b/1'],
  ['a newline', 'orbit:card/a\n1'],
  ['a quote', 'orbit:card/"a"'],
  ['a backslash', 'orbit:card\\a'],
  ['a pipe', 'orbit:card/a|b'],
  ['non-ASCII', 'orbit:card/é/1'],
  ['a less-than sign', '<script>'],
  ['a number', 12],
  ['null', null],
  ['undefined', undefined],
];

describe('the card link rule', () => {
  it.each(table)('agrees with the server on %s', (_name, value) => {
    expect(isContextLink(value)).toBe(typeof value === 'string' && server.test(value));
  });

  it('keeps the limit the server keeps', () => {
    expect(MAX_CONTEXT).toBe(256);
    expect(isContextLink('x'.repeat(MAX_CONTEXT))).toBe(true);
    expect(isContextLink('x'.repeat(MAX_CONTEXT + 1))).toBe(false);
    expect(server.test('x'.repeat(MAX_CONTEXT))).toBe(true);
    expect(server.test('x'.repeat(MAX_CONTEXT + 1))).toBe(false);
  });

  it('refuses what is not text, and what has a space', () => {
    expect(isContextLink('orbit:card/b/1')).toBe(true);
    expect(isContextLink('orbit:card/b 1')).toBe(false);
    expect(isContextLink(undefined)).toBe(false);
  });
});
