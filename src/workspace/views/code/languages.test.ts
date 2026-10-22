import { describe, expect, it } from 'vitest';
import { findLanguage } from './languages';

describe('findLanguage', () => {
  it('matches a language by extension, whatever its case', () => {
    expect(findLanguage('src/notes.ts')?.name).toBe('TypeScript');
    expect(findLanguage('App.tsx')?.name).toBe('TSX');
    expect(findLanguage('data.json')?.name).toBe('JSON');
    expect(findLanguage('config.yml')?.name).toBe('YAML');
    expect(findLanguage('scripts/plot.py')?.name).toBe('Python');
    expect(findLanguage('STYLE.CSS')?.name).toBe('CSS');
    expect(findLanguage('Observing plan.md')?.name).toBe('Markdown');
  });

  it('matches well-known file names', () => {
    expect(findLanguage('Dockerfile')?.name).toBe('Dockerfile');
    expect(findLanguage('docker/Dockerfile')?.name).toBe('Dockerfile');
  });

  it('reads Obsidian canvases as JSON', () => {
    expect(findLanguage('Board.canvas')?.name).toBe('JSON');
  });

  it('leaves plain text plain', () => {
    expect(findLanguage('Meteor showers 2026.csv')).toBeNull();
    expect(findLanguage('notes.txt')).toBeNull();
    expect(findLanguage('notes.text')).toBeNull();
    expect(findLanguage('README')).toBeNull();
  });
});
