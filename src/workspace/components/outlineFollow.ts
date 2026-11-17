import { useEffect, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { extractOutlineLines, occurrences, readingIndex, type Heading, type HeadingAt } from '../outline';

/**
 * The outline that follows you: which heading of the open note is
 * being read, in the reading view and in the editor, and a jump to a heading
 * in the editor. The reading view's headings are DOM elements, found as the
 * outline's own jumps find them (headings.ts); the editor's are lines of its
 * text, reached through the `.cm-editor` element on the stage.
 *
 * The shell never imports CodeMirror (the load budget): the editor's module
 * is imported on demand, here, and only once an editor is on the stage, which
 * has loaded that same module already.
 */

/** A heading is being read once its top is above this line: a share of the stage's height, no more than LINE_MAX px down. */
const LINE_SHARE = 0.3;
const LINE_MAX = 160;
/** Scrolled to within this many px of the end counts as the end. */
const END_SLACK = 4;

let codemirror: Promise<typeof import('@codemirror/view')> | null = null;

function editorModule() {
  codemirror ??= import('@codemirror/view');
  return codemirror;
}

/** The note editor on the stage, if one is open (not one inside it, which is an embed's). */
function stageEditor(stage: ParentNode): HTMLElement | null {
  const editor = stage.querySelector<HTMLElement>('.cm-editor');
  return editor && !editor.parentElement?.closest('.cm-editor') ? editor : null;
}

/** Whether a note editor is open on the stage (its headings are text, not elements). */
export function hasEditor(stage: ParentNode): boolean {
  return stageEditor(stage) !== null;
}

async function viewOf(editor: HTMLElement): Promise<EditorView | null> {
  const { EditorView: Editor } = await editorModule();
  return Editor.findFromDOM(editor);
}

/** The heading at `nth` among those reading `text` (the first, if the text has fewer). */
function nthHeading(headings: readonly HeadingAt[], text: string, nth: number): HeadingAt | null {
  const same = headings.filter((heading) => heading.text === text);
  return same[nth] ?? same[0] ?? null;
}

/** Puts the editor's cursor at the heading and scrolls it to the top. False if no editor is open or it holds no such heading. */
export async function jumpInEditor(stage: ParentNode, heading: Heading, nth: number): Promise<boolean> {
  const editor = stageEditor(stage);
  if (!editor) return false;
  const [view, { EditorView: Editor }] = await Promise.all([viewOf(editor), editorModule()]);
  if (!view) return false;
  const target = nthHeading(extractOutlineLines(view.state.doc.toString()), heading.text, nth);
  if (!target) return false;
  const from = view.state.doc.line(Math.min(target.line + 1, view.state.doc.lines)).from;
  view.dispatch({ selection: { anchor: from }, effects: Editor.scrollIntoView(from, { y: 'start', yMargin: 12 }) });
  view.focus();
  return true;
}

type Reading = { tops: Array<number | null>; line: number; atEnd: boolean; bottom: number };

/** The reading view's headings (the outline's, matched by text and count as a jump does), by position on screen. */
function readingTops(stage: HTMLElement, headings: readonly Heading[], nths: readonly number[], drawn: HTMLElement[]): Reading {
  const rect = stage.getBoundingClientRect();
  // Nothing is laid out (the stage is hidden): no heading is being read.
  if (rect.height === 0) return { tops: headings.map(() => null), line: 0, atEnd: false, bottom: 0 };
  const byText = new Map<string, HTMLElement[]>();
  for (const element of drawn) {
    const text = element.textContent?.trim() ?? '';
    byText.set(text, [...(byText.get(text) ?? []), element]);
  }
  return {
    tops: headings.map((heading, index) => byText.get(heading.text)?.[nths[index]]?.getBoundingClientRect().top ?? null),
    line: rect.top + Math.min(LINE_MAX, rect.height * LINE_SHARE),
    atEnd: stage.scrollHeight > stage.clientHeight && stage.scrollTop + stage.clientHeight >= stage.scrollHeight - END_SLACK,
    bottom: rect.bottom,
  };
}

function drawnHeadings(stage: HTMLElement): HTMLElement[] {
  return [...stage.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')].filter((element) => !element.closest('.ws-embed-note') && !element.closest('.cm-editor'));
}

type Outlined = { doc: unknown; lines: HeadingAt[]; nths: number[] };

/**
 * The index of the outline's heading that's being read, or null before the
 * first one. `headings` is the outline (null when no note is open).
 */
export function useReadingHeading(path: string | null, headings: Heading[] | null): number | null {
  const [current, setCurrent] = useState<number | null>(null);
  // The effect restarts when the headings change, not when the array is rebuilt with the same ones.
  const signature = headings ? headings.map((heading) => `${heading.depth}:${heading.text}`).join('\n') : null;

  useEffect(() => {
    if (!path || !headings || headings.length === 0) return undefined;
    const outline = headings;
    const nths = occurrences(outline);
    // An outline entry by its text and its count among equal ones, for matching the editor's headings to it.
    const entries = new Map(outline.map((heading, index) => [`${nths[index]}:${heading.text}`, index]));
    let stage: HTMLElement | null = null;
    let frame = 0;
    let retry = 0;
    let drawn: HTMLElement[] | null = null;
    let outlined: Outlined | null = null;
    let views = new WeakMap<HTMLElement, EditorView>();
    let stopped = false;

    const update = () => {
      frame = 0;
      if (!stage || stopped) return;
      const editor = stageEditor(stage);
      if (editor) {
        const view = views.get(editor);
        if (!view) {
          void viewOf(editor).then((found) => {
            if (found && !stopped) {
              views.set(editor, found);
              schedule();
            }
          });
          return;
        }
        const { doc } = view.state;
        if (outlined?.doc !== doc) {
          const lines = extractOutlineLines(doc.toString());
          outlined = { doc, lines, nths: occurrences(lines) };
        }
        const scroller = view.scrollDOM.getBoundingClientRect();
        const tops = outlined.lines.map((heading) => view.documentTop + view.lineBlockAt(doc.line(Math.min(heading.line + 1, doc.lines)).from).top);
        const atEnd = view.scrollDOM.scrollTop + view.scrollDOM.clientHeight >= view.scrollDOM.scrollHeight - END_SLACK;
        const at = readingIndex(tops, scroller.top + Math.min(LINE_MAX, scroller.height * LINE_SHARE), atEnd, scroller.bottom);
        setCurrent(at === null ? null : (entries.get(`${outlined.nths[at]}:${outlined.lines[at].text}`) ?? null));
        return;
      }
      drawn ??= drawnHeadings(stage);
      const { tops, line, atEnd, bottom } = readingTops(stage, outline, nths, drawn);
      setCurrent(readingIndex(tops, line, atEnd, bottom));
    };

    function schedule() {
      if (!frame && !stopped) frame = window.requestAnimationFrame(update);
    }

    // What the stage draws changes as a note loads, as embeds open and as the editor comes and goes.
    const mutations = new MutationObserver(() => {
      drawn = null;
      schedule();
    });

    const attach = () => {
      stage = document.getElementById('ws-stage');
      if (!stage) {
        // The stage is drawn in the same pass as this panel, but a slow start gets a few more looks.
        if (retry < 20) retry = window.setTimeout(attach, 100);
        return;
      }
      mutations.observe(stage, { childList: true, subtree: true, characterData: true });
      // Scroll doesn't bubble; capturing on the stage hears the page's, the editor's and an embed's.
      stage.addEventListener('scroll', schedule, { capture: true, passive: true });
      stage.addEventListener('keyup', schedule);
      window.addEventListener('resize', schedule);
      schedule();
    };
    attach();

    return () => {
      stopped = true;
      window.clearTimeout(retry);
      window.cancelAnimationFrame(frame);
      mutations.disconnect();
      stage?.removeEventListener('scroll', schedule, { capture: true });
      stage?.removeEventListener('keyup', schedule);
      window.removeEventListener('resize', schedule);
      views = new WeakMap();
    };
    // `headings` is read through `signature`: the same headings are the same outline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, signature]);

  return headings && headings.length > 0 ? current : null;
}
