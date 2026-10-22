import { describe, expect, it } from 'vitest';
import { countWords, noteTags, parseFrontmatter, toggleTaskAt } from './markdown';

const NOTE = `---
tags: [stargazing, "october"]
aliases: Plan
---
Saturday, after moonset. #dark-site

- [ ] Orion Nebula
- [x] Pleiades
`;

describe('parseFrontmatter', () => {
  it('leaves a note without frontmatter whole', () => {
    const parsed = parseFrontmatter('# Title\n\nBody');
    expect(parsed).toEqual({ data: {}, body: '# Title\n\nBody', bodyOffset: 0 });
  });

  it('splits the frontmatter from the body and remembers where the body starts', () => {
    const parsed = parseFrontmatter(NOTE);
    expect(parsed.data).toEqual({ tags: ['stargazing', 'october'], aliases: 'Plan' });
    expect(parsed.body.startsWith('Saturday, after moonset.')).toBe(true);
    expect(NOTE.slice(parsed.bodyOffset)).toBe(parsed.body);
  });

  it('reads block lists, and CRLF line endings', () => {
    const source = '---\r\ntags:\r\n  - one\r\n  - "#two"\r\n---\r\nBody';
    const parsed = parseFrontmatter(source);
    expect(parsed.data).toEqual({ tags: ['one', '#two'] });
    expect(parsed.body).toBe('Body');
  });

  it('is not fooled by a rule further down or an unclosed fence', () => {
    expect(parseFrontmatter('Intro\n---\ntags: x\n---\n').bodyOffset).toBe(0);
    expect(parseFrontmatter('---\ntags: x\nno end').bodyOffset).toBe(0);
  });
});

describe('noteTags', () => {
  it('joins frontmatter tags and inline #tags, without # and without repeats', () => {
    expect(noteTags(NOTE)).toEqual(['stargazing', 'october', 'dark-site']);
  });

  it('accepts a comma or space separated tags value', () => {
    expect(noteTags('---\ntags: one, two three\n---\n')).toEqual(['one', 'two', 'three']);
    expect(noteTags('---\ntag: solo\n---\n')).toEqual(['solo']);
  });

  it('skips headings, numbers, links, and code', () => {
    const body = [
      '# Heading',
      'Issue #42 and C# and http://x.com/#frag and [a](#anchor)',
      'Real #nested/tag and #Stargazing.',
      '`#incode`',
      '```',
      '#fenced',
      '```',
    ].join('\n');
    expect(noteTags(`---\ntags: [stargazing]\n---\n${body}`)).toEqual(['stargazing', 'nested/tag']);
  });
});

describe('countWords', () => {
  it('counts words in the body, not frontmatter or list and task markers', () => {
    expect(countWords(NOTE)).toBe(7);
    expect(countWords('')).toBe(0);
    expect(countWords('Pack — a thermos, warm layers.')).toBe(5);
  });
});

describe('toggleTaskAt', () => {
  it('ticks and unticks the task whose list item starts at the offset', () => {
    const source = '- [ ] one\n- [x] two\n- [X] three\n';
    expect(toggleTaskAt(source, 0)).toBe('- [x] one\n- [x] two\n- [X] three\n');
    expect(toggleTaskAt(source, 10)).toBe('- [ ] one\n- [ ] two\n- [X] three\n');
    expect(toggleTaskAt(source, 20)).toBe('- [ ] one\n- [x] two\n- [ ] three\n');
  });

  it('handles other bullets, ordered lists and quotes', () => {
    expect(toggleTaskAt('* [ ] a', 0)).toBe('* [x] a');
    expect(toggleTaskAt('+  [ ] a', 0)).toBe('+  [x] a');
    expect(toggleTaskAt('12. [ ] a', 0)).toBe('12. [x] a');
    expect(toggleTaskAt('3) [x] a', 0)).toBe('3) [ ] a');
    expect(toggleTaskAt('> - [ ] quoted', 2)).toBe('> - [x] quoted');
  });

  it('changes nothing when the offset is not a task', () => {
    expect(toggleTaskAt('- plain item', 0)).toBeNull();
    expect(toggleTaskAt('- [ ] a', 3)).toBeNull();
    expect(toggleTaskAt('text', 99)).toBeNull();
  });
});
