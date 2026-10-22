import { useEffect, useState } from 'react';
import type { FileViewProps } from '../../src/files/types';

/** A stand-in view for the shell's tests: shows the file's name and text,
 * reports a status, and marks itself dirty while its field has unsaved
 * text (Save writes it). Lane C's real views replace it in the app. */
export function ProbeView({ store, entry, kind, onStatus, onDirty }: FileViewProps) {
  const [text, setText] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (kind === 'note' || kind === 'text' || kind === 'canvas') {
      store
        .readText(entry.path)
        .then((value) => {
          if (!cancelled) setText(value);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [store, entry.path, entry.modified, kind]);

  useEffect(() => {
    const words = (text ?? '').split(/\s+/).filter(Boolean).length;
    onStatus?.(kind === 'note' ? `${words} words` : `${kind} · ${entry.size ?? 0} bytes`);
  }, [text, kind, entry.size, onStatus]);

  useEffect(() => {
    onDirty?.(draft.length > 0);
  }, [draft, onDirty]);

  const headings = (text ?? '')
    .split('\n')
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) => ({ depth: line.match(/^#+/)![0].length, text: line.replace(/^#+\s*/, '').trim() }));

  return (
    <div className="probe-view" data-kind={kind} style={{ padding: '1.5rem 2rem', color: 'var(--ink)' }}>
      <p className="probe-name">{entry.name}</p>
      {headings.map((heading, index) =>
        heading.depth === 1 ? <h1 key={index}>{heading.text}</h1> : <h2 key={index}>{heading.text}</h2>,
      )}
      <label>
        Draft <input className="probe-draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
      </label>
      <button
        type="button"
        className="probe-save"
        onClick={() => {
          void store.write(entry.path, `${text ?? ''}${draft}`).then(() => setDraft(''));
        }}
      >
        Save
      </button>
    </div>
  );
}
