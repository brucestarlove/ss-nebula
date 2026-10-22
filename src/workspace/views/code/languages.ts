import { languages } from '@codemirror/language-data';

export type LanguageDescription = (typeof languages)[number];

/** Extensions Nebula reads as some other language's. */
const ALIASES: Record<string, string> = {
  canvas: 'json',
  jsonc: 'json',
  json5: 'json',
};

/** Plain text, even where a mode claims the extension (LaTeX claims .text). */
const PLAIN = new Set(['txt', 'text', 'log', 'csv', 'tsv']);

/** The CodeMirror language for a file, by name: CodeMirror's own
 * matchFilename rules (a file-name pattern first, then the extension), but
 * case-insensitive about extensions. Null means plain text. */
export function findLanguage(fileName: string): LanguageDescription | null {
  const base = fileName.slice(fileName.lastIndexOf('/') + 1);
  for (const language of languages) {
    if (language.filename?.test(base)) return language;
  }
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = base.slice(dot + 1).toLowerCase();
  if (PLAIN.has(extension)) return null;
  const wanted = ALIASES[extension] ?? extension;
  return languages.find((language) => language.extensions.some((candidate) => candidate.toLowerCase() === wanted)) ?? null;
}
