import { describe, expect, it } from 'vitest';
import { newNameProblem } from '../files/paths';
import { pastedNoteName, pastedTitle, pasteStamp } from './pasteNote';

// 26 October 2026, 14:05 on the device's clock.
const at = new Date(2026, 9, 26, 14, 5);

describe('pastedNoteName', () => {
  it('names a pasted note by when it was pasted, so a folder of them reads in order', () => {
    expect(pasteStamp(at)).toBe('2026-10-26 14.05');
    expect(pastedNoteName('Here is what I changed…', at)).toBe('2026-10-26 14.05.md');
  });

  it('adds the first heading when the text opens with one', () => {
    expect(pastedNoteName('# Deploy plan\n\nSteps…', at)).toBe('2026-10-26 14.05 Deploy plan.md');
    expect(pastedNoteName('\n\n## Orbit 2.0: what shipped ##\n', at)).toBe('2026-10-26 14.05 Orbit 2.0 what shipped.md');
  });

  it('keeps a plain name when the heading comes later', () => {
    expect(pastedTitle('Done. Here is the summary.\n\n# Summary')).toBe('');
  });

  it('drops Markdown marks and links from the heading', () => {
    expect(pastedTitle('# **Bold** and `code` and [a link](https://example.com)')).toBe('Bold and code and a link');
  });

  it('never gives a name Nebula would refuse', () => {
    for (const text of ['# a/b\\c:d*e?f"g<h>i|j', '# Ends with a dot.', '# \u202Efdp.exe', '#    ', '# CON']) {
      const name = pastedNoteName(text, at);
      expect(newNameProblem(name), `${JSON.stringify(text)} → ${name}`).toBeNull();
      expect(name.startsWith('2026-10-26 14.05')).toBe(true);
      expect(name.endsWith('.md')).toBe(true);
    }
  });

  it('cuts a long heading at a word', () => {
    const title = pastedTitle(`# ${'Starscape Nebula keeps every file a project is made of '.repeat(3)}`);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith(' ')).toBe(false);
    expect('Starscape Nebula keeps every file a project is made of Starscape'.startsWith(title)).toBe(true);
  });
});
