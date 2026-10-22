import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { kindFromName } from '../../files/kinds';
import type { FileEntry, FileKind, ProjectRecord } from '../../files/types';
import { quickOpenFiles, quickOpenProjects, splitHighlights, type Highlight } from '../quickOpen';
import { WsDialog } from './Dialogs';
import { Planet } from './Button';
import { iconForFile } from './fileIcon';
import { Icon } from './icons';
import { basename } from '../../files/paths';

type QuickOpenProps = {
  open: boolean;
  entries: FileEntry[];
  kinds: Readonly<Record<string, FileKind>>;
  projects: ProjectRecord[];
  currentId: string | null;
  /** Where other projects live, shown beside them. */
  location: string;
  onOpenFile: (path: string) => void;
  onSwitchProject: (id: string) => void;
  onClose: () => void;
};

/** ⌘K / Ctrl+K: this project's files by name, then your other projects. */
export function QuickOpen(props: QuickOpenProps) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <WsDialog open={props.open} onClose={props.onClose} bare className="ws-palette ws-surface" label="Search or jump to" initialFocus={input}>
      <QuickOpenBody {...props} inputRef={input} />
    </WsDialog>
  );
}

function Marked({ text, ranges }: { text: string; ranges: Highlight[] }) {
  return (
    <>
      {splitHighlights(text, ranges).map((run, index) => (run.mark ? <mark key={index}>{run.text}</mark> : <span key={index}>{run.text}</span>))}
    </>
  );
}

type Option = { choose: () => void };

function QuickOpenBody({
  entries,
  kinds,
  projects,
  currentId,
  location,
  onOpenFile,
  onSwitchProject,
  inputRef,
}: QuickOpenProps & { inputRef: RefObject<HTMLInputElement | null> }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const base = `qo${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const files = useMemo(() => quickOpenFiles(entries, query), [entries, query]);
  const others = useMemo(() => quickOpenProjects(projects, currentId, query), [projects, currentId, query]);

  const options: Option[] = [
    ...files.map((file) => ({ choose: () => onOpenFile(file.path) })),
    ...others.map((other) => ({ choose: () => onSwitchProject(other.project.id) })),
  ];
  const current = Math.min(active, Math.max(0, options.length - 1));
  const optionId = (index: number) => `${base}-o${index}`;

  // Keep the highlighted result in view inside the list.
  useLayoutEffect(() => {
    const container = list.current;
    const option = container?.querySelector<HTMLElement>(`#${optionId(current)}`);
    if (!container || !option) return;
    if (option.offsetTop < container.scrollTop) container.scrollTop = option.offsetTop - 8;
    else if (option.offsetTop + option.offsetHeight > container.scrollTop + container.clientHeight)
      container.scrollTop = option.offsetTop + option.offsetHeight - container.clientHeight + 8;
  });

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (options.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current + step + options.length) % options.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      options[current]?.choose();
    }
  };

  let index = -1;
  const option = (choose: () => void) => {
    index += 1;
    const mine = index;
    return {
      id: optionId(mine),
      role: 'option' as const,
      'aria-selected': mine === current,
      className: 'ws-result',
      onMouseMove: () => setActive(mine),
      onClick: choose,
    };
  };

  return (
    <>
      <div className="ws-palette-input">
        <Icon name="search" />
        <input
          ref={inputRef}
          className="ws-palette-field"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${base}-list`}
          aria-activedescendant={options.length ? optionId(current) : undefined}
          aria-autocomplete="list"
          aria-label="Search files and projects"
          placeholder="Search or jump to…"
          value={query}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <kbd aria-hidden="true">esc</kbd>
      </div>
      <div ref={list} id={`${base}-list`} className="ws-results" role="listbox" aria-label="Results">
        {files.length > 0 ? (
          <div role="group" aria-labelledby={`${base}-files`}>
            <div className="ws-results-h" id={`${base}-files`}>
              Files
            </div>
            {files.map((file) => {
              const name = basename(file.path);
              return (
                <div key={file.path} {...option(() => onOpenFile(file.path))}>
                  <Icon name={iconForFile(name, kinds[file.path] ?? kindFromName(name))} />
                  <span>
                    <Marked text={file.title} ranges={file.ranges} />
                  </span>
                  {file.folder ? <small>{file.folder}</small> : null}
                </div>
              );
            })}
          </div>
        ) : null}
        {others.length > 0 ? (
          <div role="group" aria-labelledby={`${base}-projects`}>
            <div className="ws-results-h" id={`${base}-projects`}>
              Other projects
            </div>
            {others.map((other) => (
              <div key={other.project.id} {...option(() => onSwitchProject(other.project.id))}>
                <Planet color={other.project.color} />
                <span>
                  <Marked text={other.project.name} ranges={other.ranges} />
                </span>
                <small>{location}</small>
              </div>
            ))}
          </div>
        ) : null}
        {options.length === 0 ? <p className="ws-results-empty">Nothing here is called “{query.trim()}”.</p> : null}
      </div>
      <div className="ws-palette-foot" aria-hidden="true">
        <span>
          <kbd>↑↓</kbd>move
        </span>
        <span>
          <kbd>↵</kbd>open
        </span>
        <span>
          <kbd>esc</kbd>close
        </span>
      </div>
    </>
  );
}
