import { describe, expect, it } from 'vitest';
import { extractOutline } from './outline';

describe('extractOutline', () => {
  it('lists ATX headings with their depth', () => {
    const text = '# Observing plan\n\nSaturday.\n\n## Targets\n\n- M42\n\n## Pack\n\n### Warm layers\n';
    expect(extractOutline(text)).toEqual([
      { depth: 1, text: 'Observing plan' },
      { depth: 2, text: 'Targets' },
      { depth: 2, text: 'Pack' },
      { depth: 3, text: 'Warm layers' },
    ]);
  });

  it('drops closing hashes and inline marks, and keeps link text', () => {
    const text = '## **Bold** and `code` ##\n### See [Orion](Guides/Orion.md) and [[Moon phases|the moon]]\n';
    expect(extractOutline(text)).toEqual([
      { depth: 2, text: 'Bold and code' },
      { depth: 3, text: 'See Orion and the moon' },
    ]);
  });

  it('skips front matter, fenced code and hashtags', () => {
    const text = [
      '---',
      'tags: [stargazing]',
      '# not a heading',
      '---',
      '#stargazing #october',
      '```sh',
      '# a comment',
      '```',
      '~~~',
      '## also code',
      '~~~',
      '## Real',
    ].join('\n');
    expect(extractOutline(text)).toEqual([{ depth: 2, text: 'Real' }]);
  });

  it('reads underlined headings', () => {
    const text = 'Title\n=====\n\nSection\n-------\n\nText\n';
    expect(extractOutline(text)).toEqual([
      { depth: 1, text: 'Title' },
      { depth: 2, text: 'Section' },
    ]);
  });

  it('does not take a rule after a blank line, or a list item, for an underline', () => {
    expect(extractOutline('Para\n\n---\n\n- item\n---\n')).toEqual([]);
  });
});
