// What e2e/harness/storage-harness.ts puts on window, for the specs that drive it.
export type MigrationReportJson = {
  status: string;
  projects: Array<{ projectId: string; name: string; boardId: string }>;
  keys: string[];
  error?: string;
  warnings?: string[];
  rollbackErrors?: string[];
};

export type StorageHarness = {
  wipe(): Promise<void>;
  open(options?: { withoutWebLocks?: boolean }): Promise<{ persistent: boolean; reason?: string }>;
  tree(): Promise<string[]>;
  create(name: string): Promise<string>;
  writeTree(path: string, text: string): Promise<void>;
  readTree(path: string): Promise<string>;
  seedLocalStorage(entries: Record<string, string>): void;
  localStorage(): Record<string, string>;
  migrate(options?: { slowMs?: number; hangFrom?: number }): Promise<MigrationReportJson>;
  writes(): number;
  projects(): Promise<Array<{ id: string; name: string }>>;
  paths(id: string): Promise<string[]>;
  removeWhileWriting(): Promise<{ results: string[]; tree: string[] }>;
  watchNewFile(chars: number): Promise<{ sizes: number[]; listed: string[]; final: number; looks: number; move: boolean; leftover: string[] }>;
  watchOverwrite(rounds: number): Promise<{ reads: number; torn: number; lengths: number[] }>;
  runTwinCase(name: string): Promise<{ name: string; ok: boolean; error?: string }>;
  heldWriteThen(change: 'rename-file' | 'rename-folder' | 'remove-file' | 'remove-folder'): Promise<{ wentAhead: boolean; results: string[]; files: string[]; text: string | null }>;
};

declare global {
  interface Window {
    storageHarness: StorageHarness;
  }
}
