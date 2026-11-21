import type { Actor } from './types';
import type { RemovedProject } from './serverContract';

/** The names servers go by in this page (the server tier, slice 4), so a view
 * out of reach of one says "‘vps-starscape’" rather than "the folder
 * ‘vps-starscape’". Its own small module: the views ask, without loading the
 * server tier's code. */
const serverPlaces = new Set<string>();

export function addServerPlace(name: string): void {
  serverPlaces.add(name);
}

export function isServerPlace(name: string): boolean {
  return serverPlaces.has(name);
}

/** Where a project can live: the browser's own storage (OPFS), a folder the
 * person picks, or the server that served the page. */
export type Home = 'browser' | 'folder' | 'server';

export const ALL_HOMES: readonly Home[] = ['browser', 'folder', 'server'];

/** What the page's host offers: the homes a project may have here (the
 * server's place says, `GET <api>/place`), and the server, when one served
 * the page. In the Suite only `server`: the browser's storage belongs to the
 * address, not the account, so it's left alone. */
export type Hosting = {
  homes: readonly Home[];
  server: {
    label: string;
    canCreate: boolean;
    /** Who is asking, as the server's records name them: "Edited by you". */
    you?: Actor;
    /** The server keeps earlier versions of each file (History, Restore). */
    versions?: boolean;
    /** A project here can be deleted, and restored for a while (Settings → Delete project…). */
    canRemove?: boolean;
    /** The server lists the files deleted from a project, and Restore brings one back (`capabilities.deletedFiles`). */
    deletedFiles?: boolean;
    /** The projects deleted and still restorable, and restoring one; where `canRemove`. */
    removed?: RemovedProjects;
  } | null;
};

/** Deleted projects the server still holds (`GET <api>/removed-projects`). */
export type RemovedProjects = {
  list(): Promise<RemovedProject[]>;
  /** Brings one back into the project list. */
  restore(id: string): Promise<void>;
};

/** No server, or one that offers every home: as Nebula always was. */
export const STANDALONE: Hosting = { homes: ALL_HOMES, server: null };

/** The host offers only its server: nothing is listed from, or kept in, this browser. */
export function onlyServer(hosting: Hosting): boolean {
  return hosting.server !== null && !hosting.homes.includes('browser');
}
