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
