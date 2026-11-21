import { describe, expect, it } from 'vitest';
import { appBase, appHome, fileUrl, parseRoute } from './routes';

function at(url: string) {
  const parsed = new URL(url, 'https://nebula.starscape.app');
  return { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash };
}

describe('parseRoute', () => {
  it('opens the last project at the root', () => {
    expect(parseRoute(at('/'))).toBeNull();
  });

  it('reads a file link: /p/<project>/<path>, decoded', () => {
    expect(parseRoute(at('/p/k3v9x2m1qa/Guides/Observing%20plan.md'))).toEqual({
      type: 'file',
      projectId: 'k3v9x2m1qa',
      path: 'Guides/Observing plan.md',
    });
    expect(parseRoute(at('/p/k3v9x2m1qa/Charts/Star%20chart%20%E2%80%94%20October.pdf'))).toMatchObject({
      path: 'Charts/Star chart — October.pdf',
    });
  });

  it('reads a project link without a file', () => {
    expect(parseRoute(at('/p/k3v9x2m1qa'))).toEqual({ type: 'file', projectId: 'k3v9x2m1qa', path: null });
    expect(parseRoute(at('/p/k3v9x2m1qa/'))).toEqual({ type: 'file', projectId: 'k3v9x2m1qa', path: null });
  });

  it('treats a malformed link as no link, rather than failing', () => {
    expect(parseRoute(at('/p/k3v9x2m1qa/%E0%A4%A'))).toEqual({ type: 'file', projectId: 'k3v9x2m1qa', path: null });
    expect(parseRoute(at('/p/%E0%A4%A/notes.md'))).toBeNull();
    expect(parseRoute(at('/p/'))).toBeNull();
  });

  it('ignores the query', () => {
    expect(parseRoute(at('/?utm_source=mastodon'))).toBeNull();
  });

  it('reads every address the same inside /app, where the site mounts the app', () => {
    expect(parseRoute(at('/app'))).toBeNull();
    expect(parseRoute(at('/app/'))).toBeNull();
    expect(parseRoute(at('/app/p/k3v9x2m1qa/Guides/Observing%20plan.md'))).toEqual({
      type: 'file',
      projectId: 'k3v9x2m1qa',
      path: 'Guides/Observing plan.md',
    });
    expect(parseRoute(at('/app/p/k3v9x2m1qa'))).toEqual({ type: 'file', projectId: 'k3v9x2m1qa', path: null });
  });

  it('doesn’t mistake a path that only starts with “app” for the mount', () => {
    expect(appBase('/apple/p/x')).toBe('');
    expect(parseRoute(at('/apple/p/x'))).toBeNull();
  });
});

describe('parseRoute: the card a file was opened from (?context=)', () => {
  const card = 'orbit:card/board-1/12';

  it('reads the context of a file link, decoded, inside any mount', () => {
    expect(parseRoute(at(`/p/k3v9x2m1qa/Guides/Orion.md?context=${card}`))).toEqual({ type: 'file', projectId: 'k3v9x2m1qa', path: 'Guides/Orion.md', context: card });
    expect(parseRoute(at(`/p/k3v9x2m1qa/Guides/Orion.md?context=${encodeURIComponent(card)}`))).toMatchObject({ context: card });
    expect(parseRoute(at(`/app/p/k3v9x2m1qa/Guides/Orion.md?context=${card}`))).toMatchObject({ path: 'Guides/Orion.md', context: card });
    expect(parseRoute(at(`/nebula/p/k3v9x2m1qa/Guides/Orion.md?context=${card}`), '/nebula')).toMatchObject({ path: 'Guides/Orion.md', context: card });
  });

  it('a link with no context, or a project link, carries none', () => {
    expect(parseRoute(at('/p/k3v9x2m1qa/Guides/Orion.md'))).not.toHaveProperty('context');
    expect(parseRoute(at(`/p/k3v9x2m1qa?context=${card}`))).toEqual({ type: 'file', projectId: 'k3v9x2m1qa', path: null });
    expect(parseRoute(at(`/p/k3v9x2m1qa/?context=${card}`))).toEqual({ type: 'file', projectId: 'k3v9x2m1qa', path: null });
  });

  it('drops a context the server would refuse, and still opens the file', () => {
    const tooLong = `orbit:card/${'x'.repeat(246)}`; // 257
    for (const bad of ['orbit:card/a%20b/1', 'orbit:card/a+b/1', tooLong, '', 'a<b']) {
      const target = parseRoute(at(`/p/k3v9x2m1qa/Guides/Orion.md?context=${bad}`));
      expect(target, bad).toEqual({ type: 'file', projectId: 'k3v9x2m1qa', path: 'Guides/Orion.md' });
    }
  });

  it('accepts a context of exactly 256 characters', () => {
    const longest = `orbit:card/${'x'.repeat(245)}`;
    expect(longest).toHaveLength(256);
    expect(parseRoute(at(`/p/k3v9x2m1qa/Orion.md?context=${longest}`))).toMatchObject({ context: longest });
  });

  it('reads the first context, and nothing else in the query', () => {
    expect(parseRoute(at(`/p/k3v9x2m1qa/Orion.md?utm=1&context=${card}&context=orbit:card/z/9`))).toMatchObject({ context: card });
    expect(parseRoute(at('/p/k3v9x2m1qa/Orion.md?utm=1'))).not.toHaveProperty('context');
  });
});

describe('appBase and appHome', () => {
  it('finds the mount from the address the app was opened at', () => {
    expect(appBase('/app')).toBe('/app');
    expect(appBase('/app/p/k3v9x2m1qa/README.md')).toBe('/app');
    expect(appBase('/')).toBe('');
    expect(appBase('/p/k3v9x2m1qa')).toBe('');
  });

  it('names the app’s front door under each', () => {
    expect(appHome('/app')).toBe('/app');
    expect(appHome('')).toBe('/');
  });
});

describe('fileUrl', () => {
  it('writes a file link that reads back the same, whatever the name', () => {
    for (const path of ['Guides/Observing plan.md', 'Charts/Star chart — October.pdf', 'a#b?c.md', '100% done.md', 'Ünïcode/日本.txt']) {
      const url = fileUrl('k3v9x2m1qa', path);
      expect(url.startsWith('/p/k3v9x2m1qa/')).toBe(true);
      expect(url).not.toMatch(/[ #?]/);
      expect(parseRoute(at(url))).toEqual({ type: 'file', projectId: 'k3v9x2m1qa', path });
    }
  });

  it('keeps folders readable in the address', () => {
    expect(fileUrl('k3v9x2m1qa', 'Guides/Observing plan.md')).toBe('/p/k3v9x2m1qa/Guides/Observing%20plan.md');
  });

  it('links a project with nothing open', () => {
    expect(fileUrl('k3v9x2m1qa', null)).toBe('/p/k3v9x2m1qa');
  });

  it('writes links inside the mount that read back the same', () => {
    expect(fileUrl('k3v9x2m1qa', 'Concept art', '/app')).toBe('/app/p/k3v9x2m1qa/Concept%20art');
    expect(fileUrl('k3v9x2m1qa', null, '/app')).toBe('/app/p/k3v9x2m1qa');
    const url = fileUrl('k3v9x2m1qa', 'Sessions/2026-10-26 14.55 Deploy.md', '/app');
    expect(parseRoute(at(url))).toEqual({ type: 'file', projectId: 'k3v9x2m1qa', path: 'Sessions/2026-10-26 14.55 Deploy.md' });
  });
});
