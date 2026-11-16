import { memo, useContext, useEffect, useMemo, type ComponentProps } from 'react';
import Markdown, { type Components, type ExtraProps, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Glyph } from '../shared/Glyph';
import { NoteContext, WebImagesContext } from './noteContexts';
import { FileEmbed, MissingEmbed, WikiEmbed } from './embeds/Embed';
import { NoteEnvContext } from './embeds/NoteEnv';
import { WikiLink } from './embeds/WikiLink';
import { resolveMarkdownPath } from './links';
import { useProjectLinks } from '../shared/projectLinks';
import { remarkHideTitle, remarkNebula } from './remarkNebula';

/*
 * What the reading view draws a note with: react-markdown, with Nebula's
 * elements for tasks, links, images and (embeds/) wikilinks and embeds. Kept
 * apart from NoteView so an embedded note is drawn by the same code.
 */

type HastElement = NonNullable<ExtraProps['node']>;
type HastNode = HastElement | HastElement['children'][number];

function isElement(node: HastNode): node is HastElement {
  return node.type === 'element';
}

/** The state of the checkbox remark-gfm put at the start of a task item. */
function taskChecked(item: HastElement): boolean {
  for (const child of item.children) {
    if (!isElement(child)) continue;
    if (child.tagName === 'input') return Boolean(child.properties?.checked);
    if (child.tagName === 'p') {
      const input = child.children.find((grandchild) => isElement(grandchild) && grandchild.tagName === 'input');
      if (input && isElement(input)) return Boolean(input.properties?.checked);
    }
  }
  return false;
}

/** A task's own words (not its subtasks'), for the checkbox's name. */
function ownText(node: HastNode): string {
  if (node.type === 'text') return node.value;
  if (!isElement(node) || node.tagName === 'ul' || node.tagName === 'ol') return '';
  return node.children.map(ownText).join('');
}

function hasClass(className: unknown, name: string): boolean {
  return typeof className === 'string' && className.split(/\s+/).includes(name);
}

function withTaskClass(className: string | undefined): string | undefined {
  return hasClass(className, 'contains-task-list') ? `${className} ws-tasks` : className;
}

function ProseList(props: ComponentProps<'ul'> & ExtraProps) {
  const { node, className, ...rest } = props;
  void node;
  return <ul className={withTaskClass(className)} {...rest} />;
}

function ProseOrderedList(props: ComponentProps<'ol'> & ExtraProps) {
  const { node, className, ...rest } = props;
  void node;
  return <ol className={withTaskClass(className)} {...rest} />;
}

/** A list item; a task item gets a real checkbox that writes back to the
 * exact source line, found from the item's markdown position. */
function ProseItem(props: ComponentProps<'li'> & ExtraProps) {
  const { node, className, children, ...rest } = props;
  const note = useContext(NoteContext);
  if (!node || !hasClass(className, 'task-list-item')) {
    return (
      <li className={className} {...rest}>
        {children}
      </li>
    );
  }
  const checked = taskChecked(node);
  const offset = node.position?.start.offset;
  const label = ownText(node).trim() || 'Task';
  return (
    <li className={`${className} ws-task`} data-done={checked ? '' : undefined} {...rest}>
      <input
        type="checkbox"
        className="ws-check"
        checked={checked}
        aria-label={label}
        disabled={offset === undefined || !note}
        onChange={() => {
          if (offset !== undefined) note?.toggle(offset);
        }}
      />
      <div className="ws-task-body">{children}</div>
    </li>
  );
}

const EXTERNAL_LINK = /^(?:https?:|mailto:|tel:)/i;

/** Web links open in a new tab; links inside the project wait for slice 5. */
function ProseLink(props: ComponentProps<'a'> & ExtraProps) {
  const { node, href, children, className, ...rest } = props;
  void node;
  void className;
  if (href && EXTERNAL_LINK.test(href)) {
    return (
      <a {...rest} className="ws-link" href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  return (
    <span className="ws-link-local" title={href || undefined}>
      {children}
    </span>
  );
}

function hostOf(src: string): string {
  try {
    return new URL(src).host;
  } catch {
    return src;
  }
}

/** A web image held back until it's asked for: its words and where it's from. */
function HeldImage({ src, alt }: { src: string; alt: string }) {
  const images = useContext(WebImagesContext);
  useEffect(() => images.hold(), [images]);
  return (
    <span className="ws-remote-image" title={src}>
      <Glyph name="image" />
      {alt || 'Image'}
      <span className="ws-remote-host"> · {hostOf(src)}</span>
    </span>
  );
}

/** An image written as `![alt](path)`: a web image waits to be asked for; one in the project is shown, from the note's own folder. */
function ProseImage(props: ComponentProps<'img'> & ExtraProps) {
  const { node, src, alt, title } = props;
  void node;
  const images = useContext(WebImagesContext);
  const env = useContext(NoteEnvContext);
  const project = useProjectLinks();
  if (typeof src !== 'string' || src === '') return <MissingEmbed name={alt || 'Image'} />;
  // Web images load only once asked for, per note, so a
  // note can't tell anyone it was opened.
  if (/^https?:/i.test(src)) {
    if (!images.load) return <HeldImage src={src} alt={alt ?? ''} />;
    return <img src={src} alt={alt ?? ''} title={title} loading="lazy" referrerPolicy="no-referrer" />;
  }
  const file = resolveMarkdownPath(src, env?.path ?? '', project.files);
  if (!file) return <MissingEmbed name={alt || fileNameOf(src)} />;
  return <FileEmbed file={file} alt={alt || undefined} title={title} block={false} />;
}

/** The last part of an address, decoded: what a missing picture is called when it has no words of its own. */
function fileNameOf(src: string): string {
  const last = src.split(/[?#]/)[0].split('/').pop() ?? src;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** The elements remarkNebula made from `[[ ]]`: a link. Any other span is as it was. */
function ProseSpan(props: ComponentProps<'span'> & ExtraProps) {
  const { node, children, ...rest } = props;
  void node;
  const data = rest as Record<string, unknown>;
  if (typeof data['data-wikilink'] === 'string') return <WikiLink raw={data['data-wikilink']} />;
  if (typeof data['data-embed'] === 'string') return <WikiEmbed raw={data['data-embed']} block={false} />;
  return <span {...rest}>{children}</span>;
}

/** An embed that stands alone in its paragraph (remarkNebula lifts it out of the paragraph): another note's text may open out in place. */
function ProseDiv(props: ComponentProps<'div'> & ExtraProps) {
  const { node, children, ...rest } = props;
  void node;
  const embed = (rest as Record<string, unknown>)['data-embed'];
  if (typeof embed === 'string') return <WikiEmbed raw={embed} block />;
  return <div {...rest}>{children}</div>;
}

// Raw HTML never renders (no rehype-raw): react-markdown shows it as text.
// The only inputs left are remark-gfm's task boxes, which ProseItem draws.
const COMPONENTS: Components = {
  ul: ProseList,
  ol: ProseOrderedList,
  li: ProseItem,
  input: () => null,
  a: ProseLink,
  img: ProseImage,
  span: ProseSpan,
  div: ProseDiv,
};

type RemarkPlugins = NonNullable<Options['remarkPlugins']>;

/** A note's markdown body as a page's prose. `title` is the name the page already shows. */
export const NoteMarkdown = memo(function NoteMarkdown({ body, title }: { body: string; title: string }) {
  const remarkPlugins = useMemo<RemarkPlugins>(() => [remarkGfm, [remarkHideTitle, title], remarkNebula], [title]);
  return (
    <Markdown remarkPlugins={remarkPlugins} components={COMPONENTS}>
      {body}
    </Markdown>
  );
});
