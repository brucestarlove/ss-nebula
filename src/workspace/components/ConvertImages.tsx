import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { formatBytes } from '../../files/persist';
import { basename, dirname } from '../../files/paths';
import type { FileStore } from '../../files/types';
import {
  browserImageTools,
  convertImages,
  encodeImage,
  FORMATS,
  imageMoves,
  outputSize,
  readChoices,
  SIDES,
  sourceFormat,
  targetName,
  writeChoices,
  type BitmapLike,
  type ConvertChoice,
  type ConvertOutcome,
  type ImageFormat,
  type ImageTools,
  type Size,
} from '../imageConvert';
import { blobToBytes } from '../../files/bytes';
import { Button } from './Button';
import { WsDialog } from './Dialogs';
import { Icon } from './icons';
import { Segmented } from './Settings';

const GROUPED = new Intl.NumberFormat('en');
const pixels = (size: Size) => `${GROUPED.format(size.width)} \u00d7 ${GROUPED.format(size.height)} px`;

type ConvertImagesProps = {
  open: boolean;
  store: FileStore;
  /** The images, in tree order: one for a file, every one inside for a folder. */
  paths: string[];
  /** Their sizes in bytes, as the tree knows them. */
  sizes: ReadonlyMap<string, number>;
  /** For a folder: its path. */
  folder: string | null;
  tools?: ImageTools;
  /** Why converting has to wait (the project is moving, its folder is out of
   * reach), or null. While set, Convert is off, and a conversion under way
   * stops after the image in hand. */
  waitReason?: string | null;
  /** An original is about to go for its new file (convertImages' onReplace). */
  onReplace?: (from: string, to: string) => void;
  onDone: (outcomes: ConvertOutcome[]) => void;
  onCancel: () => void;
};

/** Convert an image, or a folder's images, to WebP, JPEG or PNG, smaller if
 * asked (Bruce, 2026-10-25; see src/workspace/imageConvert.ts). */
export function ConvertImagesDialog(props: ConvertImagesProps) {
  const id = useId();
  // While converting, Escape stops after the image in hand, as Stop does,
  // rather than hiding a conversion that carries on.
  const running = useRef<AbortController | null>(null);
  return (
    <WsDialog open={props.open} onClose={() => (running.current ? running.current.abort() : props.onCancel())} className="ws-convert" labelledBy={id}>
      <ConvertBody {...props} titleId={id} running={running} />
    </WsDialog>
  );
}

type Preview =
  | { status: 'opening' }
  | { status: 'ready'; bitmap: BitmapLike; moves: boolean; url: string }
  | { status: 'error'; message: string };

type Result = { key: string; blob: Blob } | { key: string; error: string } | null;

function ConvertBody({ store, paths, sizes, folder, tools = browserImageTools, waitReason = null, onReplace, onDone, onCancel, titleId, running: stop }: Omit<ConvertImagesProps, 'open'> & { titleId: string; running: RefObject<AbortController | null> }) {
  const single = paths.length === 1 && folder === null;
  const path = paths[0];
  const [choice, setChoice] = useState<ConvertChoice>(() => readChoices());
  const [writable, setWritable] = useState<ImageFormat[] | null>(null);
  const [preview, setPreview] = useState<Preview>({ status: 'opening' });
  const [result, setResult] = useState<Result>(null);
  const [running, setRunning] = useState<{ done: number; path: string } | null>(null);
  const convertButton = useRef<HTMLButtonElement>(null);
  const totalBytes = useMemo(() => paths.reduce((sum, each) => sum + (sizes.get(each) ?? 0), 0), [paths, sizes]);

  // Which formats this browser can write: one that can't writes PNG instead.
  useEffect(() => {
    let live = true;
    void Promise.all(FORMATS.map(async (format) => ((await tools.canEncode(format.type)) ? format.value : null))).then((found) => {
      if (!live) return;
      const formats = found.filter((format): format is ImageFormat => format !== null);
      setWritable(formats);
      setChoice((current) => (formats.includes(current.format) || formats.length === 0 ? current : { ...current, format: formats[0] }));
    });
    return () => {
      live = false;
    };
  }, [tools]);

  // One image: open it once, for its size, its preview and the estimate.
  useEffect(() => {
    if (!single) return undefined;
    let live = true;
    let opened: { bitmap: BitmapLike; url: string } | null = null;
    void (async () => {
      try {
        const blob = await store.readBlob(path);
        const moves = imageMoves(await blobToBytes(blob));
        const bitmap = await tools.decode(blob);
        const url = URL.createObjectURL(blob);
        opened = { bitmap, url };
        if (live) setPreview({ status: 'ready', bitmap, moves, url });
        else {
          bitmap.close();
          URL.revokeObjectURL(url);
        }
      } catch {
        if (live) setPreview({ status: 'error', message: 'This browser can’t open this image.' });
      }
    })();
    return () => {
      live = false;
      if (opened) {
        opened.bitmap.close();
        URL.revokeObjectURL(opened.url);
      }
    };
  }, [single, store, path, tools]);

  const key = `${choice.format}|${choice.quality}|${choice.side}`;
  const canWrite = writable === null || writable.includes(choice.format);

  // The estimate: the real result, made a moment after the choice settles.
  useEffect(() => {
    if (preview.status !== 'ready' || preview.moves || !canWrite) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      encodeImage(preview.bitmap, choice, tools).then(
        (blob) => live && setResult({ key, blob }),
        (reason: unknown) => live && setResult({ key, error: reason instanceof Error ? reason.message : String(reason) }),
      );
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `key` stands for the choice's format, quality and side.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, key, canWrite, tools]);

  const update = (next: Partial<ConvertChoice>) => {
    setChoice((current) => {
      const merged = { ...current, ...next };
      writeChoices(merged);
      return merged;
    });
  };

  const original = preview.status === 'ready' ? { width: preview.bitmap.width, height: preview.bitmap.height } : null;
  const sides = SIDES.filter((side) => original === null || side < Math.max(original.width, original.height));
  const sideValue = choice.side !== null && sides.includes(choice.side as (typeof SIDES)[number]) ? String(choice.side) : 'original';
  const shown = result && result.key === key ? result : null;
  const name = basename(path);
  const newName = targetName(name, choice.format);
  const moves = preview.status === 'ready' && preview.moves;
  const blocked = waitReason !== null || !canWrite || (single && (preview.status !== 'ready' || moves));

  // A move or a lost folder mid-conversion: stop after the image in hand.
  useEffect(() => {
    if (waitReason !== null) stop.current?.abort();
  }, [waitReason, stop]);

  const convert = async () => {
    const controller = new AbortController();
    stop.current = controller;
    setRunning({ done: 0, path });
    const prepared = single && shown && 'blob' in shown ? new Map([[path, shown.blob]]) : undefined;
    const outcomes = await convertImages(store, paths, { ...choice, side: sideValue === 'original' ? null : choice.side }, {
      tools,
      prepared,
      onlySmaller: !single,
      signal: controller.signal,
      onProgress: (done, _total, next) => setRunning({ done, path: next }),
      onReplace,
    });
    stop.current = null;
    onDone(outcomes);
  };

  const facts = single
    ? [sourceFormat(name), original ? pixels(original) : null, formatBytes(sizes.get(path) ?? 0)].filter(Boolean).join(' \u00b7 ')
    : `${paths.length === 1 ? '1 image' : `${GROUPED.format(paths.length)} images`} \u00b7 ${formatBytes(totalBytes)}, in \u201c${basename(folder ?? '')}\u201d${paths.some((each) => dirname(each) !== folder) ? ' and the folders in it' : ''}`;

  return (
    <div className="ws-convert-inner">
      <header className="ws-np-head">
        <h2 id={titleId}>{single ? 'Convert image' : 'Convert images'}</h2>
        <Button className="ws-icon-btn" aria-label="Close" onClick={onCancel} disabled={running !== null}>
          <Icon name="close" />
        </Button>
      </header>

      <div className="ws-convert-what">
        {single ? (
          <span className="ws-convert-thumb" aria-hidden="true">
            {preview.status === 'ready' ? <img src={preview.url} alt="" /> : <Icon name="image" />}
          </span>
        ) : (
          <span className="ws-convert-thumb" aria-hidden="true">
            <Icon name="folder" />
          </span>
        )}
        <div className="ws-convert-facts">
          <strong>{single ? name : basename(folder ?? '')}</strong>
          <span>{facts}</span>
        </div>
      </div>

      {running ? (
        <div className="ws-convert-progress" role="status">
          <progress max={paths.length} value={running.done} />
          <span>
            {single ? `Converting \u201c${name}\u201d\u2026` : `Converting ${GROUPED.format(running.done + 1)} of ${GROUPED.format(paths.length)}: ${basename(running.path)}`}
          </span>
        </div>
      ) : (
        <div className="ws-convert-fields">
          <div className="ws-field">
            <span className="ws-set-label" aria-hidden="true">
              Format
            </span>
            <Segmented
              label="Format"
              value={choice.format}
              options={FORMATS.filter((format) => writable === null || writable.includes(format.value)).map((format) => ({ value: format.value, label: format.label }))}
              onChange={(format) => update({ format })}
            />
          </div>
          {choice.format === 'png' ? null : (
            <label className="ws-field">
              <span className="ws-set-label" aria-hidden="true">
                Quality
              </span>
              <span className="ws-convert-quality">
                <input
                  type="range"
                  className="slider"
                  aria-label="Quality"
                  min={10}
                  max={100}
                  step={5}
                  value={Math.round(choice.quality * 100)}
                  aria-valuetext={`${Math.round(choice.quality * 100)}%`}
                  style={{ '--value': ((Math.round(choice.quality * 100) - 10) / 90) * 100 } as CSSProperties}
                  onChange={(event) => update({ quality: Number(event.target.value) / 100 })}
                />
                <output aria-hidden="true">{Math.round(choice.quality * 100)}%</output>
              </span>
            </label>
          )}
          <div className="ws-field">
            <span className="ws-set-label" aria-hidden="true">
              Longest side
            </span>
            <Segmented
              label="Longest side"
              value={sideValue}
              options={[{ value: 'original', label: single ? 'As it is' : 'As they are' }, ...sides.map((side) => ({ value: String(side), label: GROUPED.format(side) }))]}
              onChange={(value) => update({ side: value === 'original' ? null : Number(value) })}
            />
          </div>
          <div className="ws-field">
            <span className="ws-set-label" aria-hidden="true">
              Then
            </span>
            <Segmented
              label="Then"
              value={choice.then}
              options={[
                { value: 'keep', label: single ? 'Keep the original' : 'Keep the originals' },
                { value: 'replace', label: single ? 'Replace it' : 'Replace them' },
              ]}
              onChange={(then) => update({ then })}
            />
          </div>
        </div>
      )}

      <div className="ws-convert-notes">
        {waitReason !== null ? (
          <p className="ws-convert-warn" role="status">
            {waitReason}
          </p>
        ) : null}
        {single && !running ? <Estimate preview={preview} original={original} side={sideValue === 'original' ? null : choice.side} before={sizes.get(path) ?? 0} shown={shown} /> : null}
        {moves ? <p className="ws-convert-warn">This image moves. A still format keeps only its first frame, so Nebula leaves it as it is.</p> : null}
        {!canWrite ? <p className="ws-convert-warn">This browser can’t write {FORMATS.find((format) => format.value === choice.format)?.label} images.</p> : null}
        {writable !== null && !writable.includes('webp') ? <p>This browser can’t write WebP. Chrome, Edge and Firefox can.</p> : null}
        {!single ? <p>Images that move, and ones that wouldn’t get smaller, stay as they are.</p> : null}
        {choice.then === 'replace' && single && newName !== name ? (
          <p>
            “{name}” goes, and “{newName}” takes its place. Links to the old name in your notes won’t follow it.
          </p>
        ) : null}
        {choice.then === 'replace' && !single ? <p>Each original goes once its new file is in. Links to the old names in your notes won’t follow them.</p> : null}
        {choice.format === 'jpeg' ? <p>JPEG has no transparency, so clear parts turn white.</p> : null}
        <p>It happens on this device, and leaves out what the file carried besides the picture, like where a photo was taken.</p>
      </div>

      <footer className="ws-dialog-foot ws-np-foot">
        {running ? (
          <Button className="ws-btn-quiet" disabled={single} onClick={() => stop.current?.abort()}>
            Stop
          </Button>
        ) : (
          <>
            <Button className="ws-btn-quiet" onClick={onCancel}>
              Cancel
            </Button>
            <Button ref={convertButton} className="welcome-dialog-cta" disabled={blocked} onClick={() => void convert()}>
              {single ? 'Convert' : `Convert ${paths.length === 1 ? '1 image' : `${GROUPED.format(paths.length)} images`}`}
            </Button>
          </>
        )}
      </footer>
    </div>
  );
}

function Estimate({ preview, original, side, before, shown }: { preview: Preview; original: Size | null; side: number | null; before: number; shown: Result }) {
  if (preview.status === 'opening') return <p className="ws-convert-estimate">Opening the image…</p>;
  if (preview.status === 'error') return <p className="ws-convert-warn">{preview.message}</p>;
  if (preview.moves) return null;
  const size = original ? pixels(outputSize(original, side)) : '';
  if (!shown) return <p className="ws-convert-estimate">{size} · working out the size…</p>;
  if ('error' in shown) return <p className="ws-convert-warn">{shown.error}</p>;
  const after = shown.blob.size;
  const change = before > 0 ? Math.round((1 - after / before) * 100) : 0;
  return (
    <p className="ws-convert-estimate" data-larger={after >= before ? '' : undefined}>
      {size} · {formatBytes(before)} → <strong>{formatBytes(after)}</strong>
      {after < before ? `, ${change}% smaller` : ', no smaller than now'}
    </p>
  );
}
