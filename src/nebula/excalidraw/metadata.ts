export type NebulaTicketLink = {
  ticketId: string;
  elementIds?: string[];
  label?: string;
};

export type NebulaMissionFrame = {
  id: string;
  name?: string;
  elementIds: string[];
  description?: string;
};

export type NebulaArtifactRef = {
  id: string;
  kind?: string;
  uri?: string;
  elementIds?: string[];
  metadata?: Record<string, unknown>;
};

export type NebulaSemanticIndex = {
  summary?: string;
  keywords?: string[];
  elements?: Record<string, Record<string, unknown>>;
  updatedAt?: string;
};

export type NebulaExcalidrawMetadata = {
  ticketLinks: NebulaTicketLink[];
  missionFrames: NebulaMissionFrame[];
  artifactRefs: NebulaArtifactRef[];
  semanticIndex: NebulaSemanticIndex;
};

export function createEmptyNebulaMetadata(): NebulaExcalidrawMetadata {
  return {
    ticketLinks: [],
    missionFrames: [],
    artifactRefs: [],
    semanticIndex: {},
  };
}
