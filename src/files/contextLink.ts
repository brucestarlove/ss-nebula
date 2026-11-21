/**
 * The link an Orbit card gives a file it opens (`orbit:card/<board>/<n>`), which the file's writes
 * then name in `Nebula-Context`. The server's rule (cli/nebula-files.mjs, CONTEXT) is link
 * characters, 1 to 256 of them: the app checks the same rule, so a value the server would refuse
 * is never sent, and is dropped where it arrives (an address, a `navigate` message).
 */
const CONTEXT = /^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]{1,256}$/;

export const MAX_CONTEXT = 256;

/** Whether `value` is a context the server accepts. */
export function isContextLink(value: unknown): value is string {
  return typeof value === 'string' && CONTEXT.test(value);
}
