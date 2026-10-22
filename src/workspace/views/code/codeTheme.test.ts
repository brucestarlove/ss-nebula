import { tags } from '@lezer/highlight';
import { describe, expect, it } from 'vitest';
import { nebulaHighlightStyle } from './codeTheme';

// Node's fs without Node's types in the app's tsconfig (as sample.test.ts).
type Fs = { readFileSync(path: string, encoding: 'utf8'): string };
const fs = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown } }).process.getBuiltinModule('node:fs') as Fs;
const codeCss = fs.readFileSync('src/workspace/views/code/code.css', 'utf8');

// The editor's token colours come from the page's CSS variables (code.css
// maps them to ss-ui's tokens), so night and day each get real colours:
// no fixed colours in the style, and no invert filter at night.

function rules(): string {
  return nebulaHighlightStyle.module?.getRules() ?? '';
}

function declarationsFor(tag: Parameters<typeof nebulaHighlightStyle.style>[0][number]): string {
  const name = nebulaHighlightStyle.style([tag]);
  if (!name) return '';
  return rules()
    .split('}')
    .filter((rule) => rule.split('{')[0].split(',').some((selector) => selector.trim() === `.${name}`))
    .map((rule) => rule.split('{')[1] ?? '')
    .join(';');
}

function colourFor(tag: Parameters<typeof declarationsFor>[0]): string | null {
  return declarationsFor(tag).match(/(?:^|;)\s*color:\s*([^;]+)/)?.[1].trim() ?? null;
}

describe('nebulaHighlightStyle', () => {
  it('colours each kind of token from a CSS variable', () => {
    expect(colourFor(tags.keyword)).toBe('var(--ws-code-keyword)');
    expect(colourFor(tags.string)).toBe('var(--ws-code-string)');
    expect(colourFor(tags.number)).toBe('var(--ws-code-number)');
    expect(colourFor(tags.comment)).toBe('var(--ws-code-comment)');
    expect(colourFor(tags.typeName)).toBe('var(--ws-code-type)');
    expect(colourFor(tags.invalid)).toBe('var(--ws-code-invalid)');
    expect(colourFor(tags.link)).toBe('var(--ws-code-link)');
  });

  it('sets markdown in its own weights and styles', () => {
    expect(declarationsFor(tags.heading)).toMatch(/font-weight:\s*(bold|[6-9]00)/);
    expect(declarationsFor(tags.strong)).toMatch(/font-weight:\s*(bold|[6-9]00)/);
    expect(declarationsFor(tags.emphasis)).toMatch(/font-style:\s*italic/);
  });

  it('uses no fixed colours', () => {
    expect(rules()).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });

  it('has every variable it uses defined in code.css, from ss-ui’s tokens', () => {
    const used = new Set(rules().match(/--ws-code-[a-z]+/g) ?? []);
    expect(used.size).toBeGreaterThanOrEqual(7);
    for (const variable of used) expect(codeCss).toMatch(new RegExp(`${variable}:\\s*[^;]*var\\(--`));
  });

  it('no longer draws the editor in day colours flipped by a filter at night', () => {
    expect(codeCss).not.toMatch(/filter:\s*invert/);
  });
});
