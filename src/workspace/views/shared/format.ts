/** Small, pure formatters for the status line and the info card. English
 * copy, like the rest of Nebula's interface. */
import { formatBytes as formatSize } from '../../../files/persist';
import type { Actor } from '../../../files/types';

/** '820 KB', '1.2 MB' (src/files/persist.ts's formatBytes); empty when the
 * size isn't known. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  return formatSize(bytes);
}

/** '3:24', '1:02:03'. Empty for live streams and unknown lengths. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const ss = String(secs).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

const GROUPED = new Intl.NumberFormat('en-US');

/** '1 word', '1,204 words'. */
export function formatCount(count: number, singular: string): string {
  return `${GROUPED.format(count)} ${count === 1 ? singular : `${singular}s`}`;
}

/** Lines of text, not counting the empty line after a final newline. */
export function countLines(text: string): number {
  if (text === '') return 0;
  let lines = 1;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) lines += 1;
  return text.endsWith('\n') ? lines - 1 : lines;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DAY_MONTH = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const DAY_MONTH_YEAR = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** When, as the edited line says it: 'just now', '4 min ago', 'yesterday', '4 Jul'. */
export function formatWhen(time: number | undefined, now: number = Date.now()): string {
  if (time === undefined || !Number.isFinite(time)) return '';
  const age = Math.max(0, now - time);
  if (age < MINUTE) return 'just now';
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`;
  if (age < DAY) {
    const hours = Math.floor(age / HOUR);
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  }
  const days = Math.floor(age / DAY);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear();
  return (sameYear ? DAY_MONTH : DAY_MONTH_YEAR).format(time);
}

/** Whether `actor` is the person using this app: the server's own record of them (`ServerInfo.you`)
 * names them the same way, by type and id. */
export function isYou(actor: Actor | undefined, you: Actor | undefined): boolean {
  return actor !== undefined && you !== undefined && actor.type === you.type && actor.id === you.id;
}

/** Who, as the edited line says it: 'you', or the actor's name. */
export function formatActor(actor: Actor, you?: Actor): string {
  return isYou(actor, you) ? 'you' : actor.name || actor.id;
}

/** The note's meta line and the status line: 'Edited 4 min ago', 'Edited yesterday', 'Edited 4 Jul';
 * with an actor (a server's listing names who wrote the file), 'Edited by Lear, 4 min ago' or
 * 'Edited by you, 4 min ago'. Without one, the time alone. */
export function formatEdited(modified: number | undefined, now: number = Date.now(), by?: Actor, you?: Actor): string {
  const when = formatWhen(modified, now);
  if (!when) return '';
  return by ? `Edited by ${formatActor(by, you)}, ${when}` : `Edited ${when}`;
}

/** '5 Dec 2026'. */
export function formatDay(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  return DAY_MONTH_YEAR.format(ms);
}

const DATE_TIME = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/** The info card: '22 Oct 2026, 03:05'. */
export function formatDateTime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  return DATE_TIME.format(ms);
}

const COMPOUND_EXTENSIONS = ['.excalidraw.md'];

/** The file name without its extension: 'Winter hexagon.excalidraw.md' is
 * 'Winter hexagon'. Names that start with a dot keep it. */
export function titleFromName(name: string): string {
  const lower = name.toLowerCase();
  for (const extension of COMPOUND_EXTENSIONS) {
    if (lower.endsWith(extension) && name.length > extension.length) return name.slice(0, -extension.length);
  }
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** 'Guides/Observing plan.md' is in 'Guides'; a file at the root is in ''. */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash > 0 ? path.slice(0, slash) : '';
}

/** 'ZIP file' for archive.zip; 'File' without an extension. */
export function kindLabel(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'File';
  return `${name.slice(dot + 1).toUpperCase()} file`;
}
