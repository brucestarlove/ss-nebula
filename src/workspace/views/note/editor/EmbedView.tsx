import { Component, type ReactNode, useMemo } from 'react';
import { ProjectLinksContext, type ProjectLinks } from '../../shared/projectLinks';
import { FileEmbed, MissingEmbed, WikiEmbed } from '../embeds/Embed';
import { NoteEnvContext, type NoteEnv } from '../embeds/NoteEnv';
import { embedFile, embedName, type EmbedLine } from './embedLine';
import type { EditorLinks } from './projectLinks';

/* ---- the widget's React tree -------------------------------------------- */

/** If a component throws, the name stands as a link and the editor carries on. */
class EmbedBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn('Nebula couldn’t draw an embed in the editor', error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function EmbedView({ embed, links }: { embed: EmbedLine; links: EditorLinks }) {
  const project = useMemo<ProjectLinks>(() => ({ files: links.files, open: links.open, create: links.create }), [links.files, links.open, links.create]);
  const env = useMemo<NoteEnv | null>(() => (links.store ? { store: links.store, projectId: links.projectId, path: links.path, depth: 0, chain: [links.path] } : null), [links.store, links.projectId, links.path]);
  const file = embedFile(embed, links);
  const name = embedName(embed);
  const fallback = file ? (
    <a role="link" tabIndex={0} className="ws-wikilink" title={file.path} onClick={() => links.open(file.path)}>
      {name}
    </a>
  ) : (
    <MissingEmbed name={name} />
  );
  let body: ReactNode;
  if (embed.kind === 'wiki') body = <WikiEmbed raw={embed.raw} block />;
  else body = file ? <FileEmbed file={file} alt={embed.alt || undefined} title={embed.title} block={false} /> : <MissingEmbed name={name} />;
  return (
    <ProjectLinksContext.Provider value={project}>
      <NoteEnvContext.Provider value={env}>
        <EmbedBoundary fallback={fallback}>{body}</EmbedBoundary>
      </NoteEnvContext.Provider>
    </ProjectLinksContext.Provider>
  );
}

