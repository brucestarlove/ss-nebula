/**
 * Paste as note: the clipboard's text becomes
 * a note in one step, for what he keeps by hand, like an agent session's
 * output "copy/pasting outputs into files for me to track, separate from the
 * agent doing it". The note is named by the moment it was pasted, so a folder
 * of them reads in order, and by its first heading when the text opens with
 * one: `2026-10-26 14.55 Deploy plan.md`.
 */
import { newNameProblem } from '../files/paths';

/** How long a heading may make a name, in characters, before it's cut at a word. */
const TITLE_MAX = 60;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `2026-10-26 14.55`, in the device's own time: a dot, since ':' is reserved on Windows. */
export function pasteStamp(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}`;
}

/** A heading's words, made safe for a file name: Markdown's marks dropped,
 * reserved characters made spaces, cut at a word to TITLE_MAX. */
function titleFrom(heading: string): string {
  let title = heading
    .replace(/[`*_~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/<>:"|?*\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (title.length > TITLE_MAX) {
    const cut = title.slice(0, TITLE_MAX + 1);
    const space = cut.lastIndexOf(' ');
    title = (space > TITLE_MAX / 2 ? cut.slice(0, space) : cut.slice(0, TITLE_MAX)).trim();
  }
  return title.replace(/[. ]+$/, '');
}

/** The pasted text's title: its first line, when that line is a Markdown
 * heading; '' otherwise, so a reply that opens with prose keeps a plain name. */
export function pastedTitle(text: string): string {
  const first = text.split(/\r?\n/).find((line) => line.trim() !== '');
  const heading = first ? /^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/.exec(first) : null;
  return heading ? titleFrom(heading[1]) : '';
}

/** The pasted note's file name, always one Nebula would accept. */
export function pastedNoteName(text: string, at: Date): string {
  const title = pastedTitle(text);
  const name = `${pasteStamp(at)}${title ? ` ${title}` : ''}.md`;
  return newNameProblem(name) === null ? name : `${pasteStamp(at)}.md`;
}
