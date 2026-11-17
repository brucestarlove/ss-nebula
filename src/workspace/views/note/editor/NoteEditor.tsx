import { Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useEffect, useId, useRef, useState } from 'react';
import type { FileStore } from '../../../../files/types';
import CodeEditor, { type CodeEditorProps } from '../../code/CodeEditor';
import { isApplePlatform } from '../../shared/hooks';
import { useProjectLinks } from '../../shared/projectLinks';
import { editorNames } from './accessibility';
import { projectLinksFacet, type EditorLinks } from './projectLinks';
import { modeExtensions, noteEditorSetup } from './setup';
import '../../code/code.css';
import './editor.css';

export type NoteEditorProps = Omit<CodeEditorProps, 'variant' | 'onLanguage'> & {
  /** The note's path in the project, for the links it names. */
  path?: string;
  /** Where the project's files are read from: embeds, and a link's headings. */
  store?: FileStore;
  projectId?: string;
  /** Edit the plain source, without live preview: a note too long to draw
   * quickly. Read once, when the editor opens, so a note that grows past the
   * limit while it's edited keeps its editor and its undo history. */
  plainSource?: boolean;
  /** Show the plain Markdown, every decoration off (the source switch). Changes without a new editor. */
  source?: boolean;
  /** Escape: the page takes the focus (its toolbar). Without it Escape does nothing here. */
  onLeave?: () => void;
};

/**
 * A note's editor: CodeMirror 6 with live preview, the Markdown drawn as the
 * page around the line being edited. The document is always the file's real
 * text; everything drawn is decoration. Loaded only when a note is edited
 * (the load budget).
 */
export default function NoteEditor(props: NoteEditorProps) {
  const [plain] = useState(Boolean(props.plainSource));
  if (plain) {
    const { path, plainSource, store, projectId, source, onLeave, ...rest } = props;
    void path;
    void plainSource;
    void store;
    void projectId;
    void source;
    void onLeave;
    return <CodeEditor {...rest} variant="note" />;
  }
  return <LiveEditor {...props} />;
}

function LiveEditor(props: NoteEditorProps) {
  const { value, revision, readOnly = false, path = '', store = null, projectId = '', source = false } = props;
  const projectLinks = useProjectLinks();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const linksRef = useRef(new Compartment());
  const modeRef = useRef(new Compartment());
  const namesRef = useRef(new Compartment());
  const descriptionId = useId();
  const appliedSource = useRef(source);
  const appliedLabel = useRef(props.label);
  const latest = useRef(props);
  const appliedRevision = useRef(revision);
  const links: EditorLinks = { ...projectLinks, path, store, projectId };
  const latestLinks = useRef(links);

  useEffect(() => {
    latest.current = props;
    latestLinks.current = links;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    appliedRevision.current = latest.current.revision;
    appliedSource.current = Boolean(latest.current.source);
    appliedLabel.current = latest.current.label;
    const view = new EditorView({
      parent: host,
      doc: latest.current.value,
      extensions: [
        noteEditorSetup({
          label: latest.current.label,
          readOnly,
          source: appliedSource.current,
          mode: modeRef.current,
          names: namesRef.current,
          describedBy: descriptionId,
          leave: () => {
            const leave = latest.current.onLeave;
            if (!leave) return false;
            leave();
            return true;
          },
        }),
        linksRef.current.of(projectLinksFacet.of(latestLinks.current)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) latest.current.onChange(update.state.doc.toString());
        }),
      ],
    });
    viewRef.current = view;
    if (latest.current.autoFocus) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [readOnly, descriptionId]);

  // The name says which mode the editor is in, so it changes with the switch.
  const { label } = props;
  useEffect(() => {
    if (appliedLabel.current === label) return;
    appliedLabel.current = label;
    viewRef.current?.dispatch({ effects: namesRef.current.reconfigure(editorNames(label, readOnly, descriptionId)) });
  }, [label, readOnly, descriptionId]);

  // The project's files reach the editor without rebuilding it.
  const { files, open, create } = projectLinks;
  useEffect(() => {
    viewRef.current?.dispatch({ effects: linksRef.current.reconfigure(projectLinksFacet.of({ files, open, create, path, store, projectId })) });
  }, [files, open, create, path, store, projectId]);

  // Live preview or the source, in the same editor: its undo history and
  // selection stay, and the line at the top of the screen stays there.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || appliedSource.current === source) return;
    appliedSource.current = source;
    let anchor: ReturnType<typeof screenAnchor> = null;
    try {
      anchor = screenAnchor(view);
    } catch {
      // Nothing laid out to measure (a test without layout): the scroll is left as it is.
    }
    view.dispatch({ effects: modeRef.current.reconfigure(modeExtensions(source)) });
    if (anchor) view.dispatch({ effects: EditorView.scrollIntoView(anchor.pos, { y: 'start', yMargin: anchor.offset }) });
  }, [source]);

  // Text from disk replaces the editor's; typing never comes back through here.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || appliedRevision.current === revision) return;
    appliedRevision.current = revision;
    const current = view.state.doc.toString();
    // CodeMirror keeps \n line ends: a CRLF file read again is the same text.
    if (current !== value && current !== value.replace(/\r\n?/g, '\n')) view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [revision, value]);

  return (
    <>
      <div ref={hostRef} className={`ws-cm ws-cm-note ${source ? 'ws-cm-source' : 'ws-cm-live'}`} data-testid="note-editor" />
      <span id={descriptionId} className="ws-visually-hidden">
        {describe(source)}
      </span>
    </>
  );
}

/** What a screen reader is told about the editor when it arrives: the mode, the keys the drawn page can't show, and the way out. */
function describe(source: boolean): string {
  const mod = isApplePlatform() ? '⌘' : 'Ctrl';
  const open = `${mod}+Enter opens the link at the cursor, or ticks the task on its line.`;
  const leave = 'Escape leaves the editor for the toolbar.';
  return source
    ? `Markdown source. ${open} ${mod}+Shift+E returns to live preview. ${leave}`
    : `Live preview. The line you are on shows its Markdown. ${open} ${mod}+Shift+E shows the Markdown source. ${leave}`;
}

/** The scrolling element the editor sits in (the stage), or null. */
function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/**
 * What to keep in place when the editor's look changes: the cursor's line if
 * it's on screen, else the line at the top of the screen, and how far it is
 * from the top of the scrolling area.
 */
function screenAnchor(view: EditorView): { pos: number; offset: number } | null {
  const scroller = scrollParent(view.dom);
  const top = scroller ? scroller.getBoundingClientRect().top : 0;
  const bottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
  const head = view.state.selection.main.head;
  const cursor = view.coordsAtPos(head);
  if (cursor && cursor.top >= top && cursor.bottom <= bottom) return { pos: head, offset: cursor.top - top };
  const content = view.contentDOM.getBoundingClientRect();
  const pos = view.posAtCoords({ x: content.left + 4, y: Math.max(top, content.top) + 4 });
  if (pos === null) return null;
  const at = view.coordsAtPos(pos);
  return at ? { pos, offset: Math.max(0, at.top - top) } : null;
}
