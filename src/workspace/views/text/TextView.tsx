import { useEffect, useState } from 'react';
import type { FileViewProps } from '../../../files/types';
import CodeEditor from '../code/CodeEditor';
import OtherView from '../other/OtherView';
import { downloadEntry } from '../shared/download';
import { countLines, formatCount } from '../shared/format';
import { Glyph } from '../shared/Glyph';
import { SessionBars, ViewLoading } from '../shared/SessionBars';
import { useTextSession } from '../shared/useTextSession';
import '../views.css';
import './text.css';

/** Text and code: CodeMirror with the file's language, saved as you type. */
export default function TextView(props: FileViewProps) {
  const { projectId, store, entry, onStatus, onDirty } = props;
  const { session, state } = useTextSession(store, entry.path, projectId);
  const [language, setLanguage] = useState<string | null>(null);

  const lines = countLines(state.text);
  useEffect(() => {
    if (state.status === 'ready') onStatus?.(formatCount(lines, 'line'));
  }, [onStatus, lines, state.status]);

  useEffect(() => {
    onDirty?.(state.dirty);
  }, [onDirty, state.dirty]);

  if (state.status === 'error') return <OtherView {...props} error={state.error} />;
  if (state.status === 'loading' || !session) return <ViewLoading name={entry.name} />;

  return (
    <div className="ws-text">
      <SessionBars session={session} state={state} onDownload={() => void downloadEntry(store, entry).catch(() => undefined)} />
      <section className="ws-code-sheet" aria-label={entry.name}>
        <header className="ws-code-head">
          <Glyph name="data" />
          <span className="ws-code-name">{entry.name}</span>
          <span className="ws-code-lang">{language ?? 'Plain text'}</span>
        </header>
        <CodeEditor
          value={state.text}
          revision={state.revision}
          onChange={session.edit}
          fileName={entry.name}
          variant="code"
          label={`${entry.name}, ${language ?? 'plain text'}`}
          readOnly={state.readOnly}
          onLanguage={setLanguage}
        />
      </section>
    </div>
  );
}
