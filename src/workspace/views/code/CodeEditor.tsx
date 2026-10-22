import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { basicSetup, EditorView } from 'codemirror';
import { useEffect, useRef } from 'react';
import { nebulaEditorTheme, nebulaHighlighting } from './codeTheme';
import { findLanguage } from './languages';
import './code.css';

type Extension = typeof basicSetup;

export type CodeEditorProps = {
  /** The text to show. The editor takes it whenever `revision` changes. */
  value: string;
  /** Bumped when `value` comes from disk (a load or a reload), not from typing. */
  revision: number;
  onChange(text: string): void;
  fileName: string;
  /** 'note': markdown in the note's own type, wrapped, without gutters.
   * 'code': line numbers, folding and the file's language. */
  variant: 'note' | 'code';
  /** The editor's accessible name. */
  label: string;
  autoFocus?: boolean;
  /** Shown, never edited: a file that isn't UTF-8. */
  readOnly?: boolean;
  /** The language CodeMirror picked (null for plain text). */
  onLanguage?(name: string | null): void;
};

async function languageFor(fileName: string, variant: CodeEditorProps['variant']): Promise<{ extension: Extension; name: string | null }> {
  if (variant === 'note') return { extension: markdown({ codeLanguages: languages }), name: 'Markdown' };
  const description = findLanguage(fileName);
  if (!description) return { extension: [], name: null };
  try {
    return { extension: await description.load(), name: description.name };
  } catch {
    // The language chunk failed to load: edit as plain text rather than not at all.
    return { extension: [], name: null };
  }
}

/** CodeMirror 6, themed from the page's CSS variables. Loaded only with the
 * text view and a note's edit mode. */
export default function CodeEditor(props: CodeEditorProps) {
  const { fileName, variant, value, revision, readOnly = false } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef(props);
  const appliedRevision = useRef(revision);

  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let cancelled = false;
    let view: EditorView | null = null;
    void languageFor(fileName, variant).then(({ extension, name }) => {
      if (cancelled) return;
      latest.current.onLanguage?.(name);
      appliedRevision.current = latest.current.revision;
      view = new EditorView({
        parent: host,
        doc: latest.current.value,
        extensions: [
          basicSetup,
          extension,
          variant === 'note' ? EditorView.lineWrapping : [],
          nebulaEditorTheme,
          nebulaHighlighting,
          EditorView.contentAttributes.of({ 'aria-label': latest.current.label, ...(readOnly ? { 'aria-readonly': 'true' } : {}) }),
          EditorView.editable.of(!readOnly),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString());
          }),
        ],
      });
      viewRef.current = view;
      if (latest.current.autoFocus) view.focus();
    });
    return () => {
      cancelled = true;
      view?.destroy();
      viewRef.current = null;
    };
  }, [fileName, variant, readOnly]);

  // Text from disk replaces the editor's; typing never comes back through here.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || appliedRevision.current === revision) return;
    appliedRevision.current = revision;
    const current = view.state.doc.toString();
    // CodeMirror keeps \n line ends: a CRLF file read again is the same text.
    if (current !== value && current !== value.replace(/\r\n?/g, '\n')) view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [revision, value]);

  return <div ref={hostRef} className={`ws-cm ws-cm-${variant}`} data-testid="code-editor" />;
}
