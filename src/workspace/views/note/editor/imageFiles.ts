import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { kindFromName } from '../../../../files/kinds';
import { basename } from '../../../../files/paths';
import type { FileEntry, FileStore } from '../../../../files/types';
import { blobBytes, imageFileName, imageLink, imageMime, isKeptImageType, ownImageName, writeImageFile } from '../../../attachments';
import { FILE_DRAG_TYPE } from '../../../dragTypes';
import { errorMessage } from '../../shared/download';

/**
 * Images pasted or dropped into a note while it's edited (2.0.4), as Obsidian
 * does them and as a canvas already does: each image becomes a file of its own
 * in `Attachments/` (attachments.ts: `Pasted image 20261121013000.png`, or the
 * dropped file's own name, create-only, a free name when taken), and the note
 * gets `![[name]]` at the cursor or the drop point, in the shortest form that
 * names that file alone. Several images go in one per line.
 *
 * The write is asynchronous and the editor stays usable meanwhile. Where the
 * link goes is a point the document's changes carry along, so typing during
 * the write moves it with the text rather than leaving it behind. A file that
 * can't be written inserts nothing and says why in the note's status; what the
 * person typed is never touched, and a file already written stays (an image
 * that was kept is never thrown away).
 *
 * A file dragged from Nebula's own file tree is a link to it, with no copy:
 * the tree's drag carries the file's path (dragTypes.ts).
 *
 * Text paste and drop are left exactly alone: this handles a paste only when
 * the clipboard holds an image and no text of its own, and a drop only when
 * it carries image files or a tree file. Anything else, a non-image file
 * dropped in included, goes on as it did before.
 */

/** What the extension needs of the note around it, read when it's needed (props change). */
export type ImageFilesTarget = {
  /** Where the project's files live; null when the editor stands alone (then nothing is kept). */
  store: FileStore | null;
  /** The project's files now, for a link from a tree drag. */
  files: readonly FileEntry[];
  /** The note's status line: why an image wasn't added. */
  onStatus?: (message: string) => void;
};

/** Where an insertion goes while its file is written: carried along by the document's changes. */
const addPoint = StateEffect.define<{ id: number; pos: number }>();
const dropPoint = StateEffect.define<number>();

const points = StateField.define<ReadonlyMap<number, number>>({
  create: () => new Map(),
  update(value, tr) {
    let next = value;
    if (tr.docChanged && value.size > 0) {
      // Text typed right at the point goes before it, so the link lands after what the person is writing.
      next = new Map([...value].map(([id, pos]) => [id, tr.changes.mapPos(pos, 1)]));
    }
    for (const effect of tr.effects) {
      if (effect.is(addPoint)) next = new Map(next).set(effect.value.id, effect.value.pos);
      else if (effect.is(dropPoint) && next.has(effect.value)) {
        const rest = new Map(next);
        rest.delete(effect.value);
        next = rest;
      }
    }
    return next;
  },
});

let nextPoint = 0;

/** Whether a file is an image: by its type, or its name when the type is empty (a drop from some systems). */
function isImage(file: File): boolean {
  return file.type.startsWith('image/') || imageMime(file.name) !== null;
}

function imageFilesIn(list: FileList | null | undefined): File[] {
  return list ? [...list].filter(isImage) : [];
}

/** The type to keep a file as: its own when Nebula keeps it, else what its name says. */
function mimeOf(file: File): string {
  return isKeptImageType(file.type) ? file.type : (imageMime(file.name) ?? file.type);
}

/**
 * The name a dropped file brings, made safe to write inside `![[ ]]`: a `#`, `|`,
 * `^` or bracket in a link means a heading, an alias, a block or nothing, so
 * each is swapped for `_`. A name that was already fine is untouched.
 */
function linkableName(file: File): string | undefined {
  return ownImageName(file)?.replace(/[#|^[\]]/g, '_');
}

/** Whether the clipboard's text is only the files' own names (a file copied in a file manager carries it), not text to paste. */
function textIsFileNames(text: string, files: readonly File[]): boolean {
  const names = new Set(files.map((file) => file.name));
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  return lines.length > 0 && lines.every((line) => names.has(line.trim()));
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** What the status line says when some images weren't added. */
function problemMessage(problems: readonly { name: string; why: string }[]): string {
  const [first] = problems;
  if (problems.length === 1) return `Couldn’t add “${first.name}”. ${sentence(first.why)}`;
  return `Couldn’t add ${problems.length} images. ${sentence(first.why)}`;
}

/** Writes each image, then puts the links where `id`'s point has got to. */
async function keep(view: EditorView, files: File[], id: number, target: () => ImageFilesTarget, userEvent: string): Promise<void> {
  const { store, onStatus } = target();
  const links: string[] = [];
  const problems: { name: string; why: string }[] = [];
  const fail = (file: File, error: unknown) => problems.push({ name: file.name || 'image', why: errorMessage(error) });
  try {
    if (!store) throw new Error('This note has nowhere to keep images.');
    // A fresh list: it says which names are taken and what the link has to tell apart.
    let known: FileEntry[] = await store.list();
    for (const file of files) {
      try {
        const mimeType = mimeOf(file);
        const bytes = { mimeType, bytes: await blobBytes(file) };
        const name = imageFileName(mimeType, new Date(), linkableName(file));
        const written = await writeImageFile(store, bytes, { name, files: known });
        known = [...known, { path: written, name: basename(written), type: 'file' }];
        links.push(`![[${imageLink(written, known)}]]`);
      } catch (error: unknown) {
        fail(file, error);
      }
    }
  } catch (error: unknown) {
    for (const file of files) fail(file, error);
  }
  // The editor went while the files were written: they're kept, and there is nowhere to link them.
  if (view.dom.isConnected) {
    const at = view.state.field(points).get(id) ?? view.state.selection.main.head;
    const text = links.join('\n');
    const selection = view.state.selection.main;
    view.dispatch({
      changes: text ? { from: at, insert: text } : undefined,
      // The cursor goes after the link when it was at the point, as after typing it.
      selection: text && selection.empty && selection.head === at ? { anchor: at + text.length } : undefined,
      effects: [dropPoint.of(id), ...(links.length > 0 ? [EditorView.announce.of(`Added ${links.length === 1 ? 'an image' : `${links.length} images`}`)] : [])],
      userEvent,
      scrollIntoView: Boolean(text),
    });
  }
  if (problems.length > 0) onStatus?.(problemMessage(problems));
}

/** Starts keeping `files`, with a point at `pos` for their links. */
function start(view: EditorView, files: File[], pos: number, target: () => ImageFilesTarget, userEvent: string): void {
  nextPoint += 1;
  const id = nextPoint;
  view.dispatch({ effects: addPoint.of({ id, pos }) });
  void keep(view, files, id, target, userEvent);
}

/** The link a file dragged from the tree is written as: a note is linked, anything else embedded (as Obsidian does). */
function treeLink(path: string, files: readonly FileEntry[]): string {
  const link = imageLink(path, files);
  return kindFromName(basename(path)) === 'note' ? `[[${link}]]` : `![[${link}]]`;
}

/** Images pasted or dropped into the note editor, and files dragged in from the tree. `target` is read at the time of each event. */
export function imageFiles(target: () => ImageFilesTarget): Extension {
  return [
    points,
    EditorView.domEventHandlers({
      paste(event, view) {
        const data = event.clipboardData;
        if (!data || view.state.readOnly) return false;
        const images = imageFilesIn(data.files);
        if (images.length === 0) return false;
        // Text is the paste, as it was: a copied table or a formatted page carries a picture of itself beside its words.
        const text = data.getData('text/plain');
        if (text.trim() !== '' && !textIsFileNames(text, [...data.files])) return false;
        event.preventDefault();
        start(view, images, view.state.selection.main.head, target, 'input.paste');
        return true;
      },
      drop(event, view) {
        const data = event.dataTransfer;
        if (!data || view.state.readOnly) return false;
        const at = () => view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
        const images = imageFilesIn(data.files);
        if (images.length > 0) {
          event.preventDefault();
          start(view, images, at(), target, 'input.drop');
          return true;
        }
        // A file from Nebula's own tree: a link to it, nothing copied. Only a file this project holds.
        const path = data.getData(FILE_DRAG_TYPE);
        const { files } = target();
        if (path && files.some((entry) => entry.type === 'file' && entry.path === path)) {
          event.preventDefault();
          const pos = at();
          const text = treeLink(path, files);
          view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length }, userEvent: 'input.drop', scrollIntoView: true });
          view.focus();
          return true;
        }
        return false;
      },
    }),
  ];
}
