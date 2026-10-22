import { describe, expect, it } from 'vitest';
import { isTrustWaiting, onTrustWaiting, setTrustWaiting, trustCandidates, trustedFolders } from './workspaceTrust';

describe('trustedFolders', () => {
  it('lists only the projects with the flag set to true', () => {
    const text = JSON.stringify({
      numStartups: 3,
      projects: {
        '/w/app': { hasTrustDialogAccepted: true, allowedTools: [] },
        '/w/other': { hasTrustDialogAccepted: false },
        '/w/bare': {},
        '/w/odd': { hasTrustDialogAccepted: 'yes' },
      },
    });
    expect([...trustedFolders(text)!]).toEqual(['/w/app']);
  });

  it('is empty, not unknown, for a config with no projects yet', () => {
    expect(trustedFolders('{"numStartups":1}')?.size).toBe(0);
  });

  it('is unknown for anything that is not that config', () => {
    expect(trustedFolders('{"projects":')).toBeNull(); // caught mid-write
    expect(trustedFolders('[]')).toBeNull();
    expect(trustedFolders('{"projects":[]}')).toBeNull();
    expect(trustedFolders('null')).toBeNull();
  });
});

describe('trustCandidates', () => {
  it('walks from the folder up to the top of its working tree, then adds the main checkout', () => {
    expect(trustCandidates('/w/agents/app/feat/sub', '/w/agents/app/feat', '/w/app')).toEqual([
      '/w/agents/app/feat/sub',
      '/w/agents/app/feat',
      '/w/app',
    ]);
  });

  it('does not climb above the repository: a trusted parent folder does not cover it', () => {
    expect(trustCandidates('/w/app', '/w/app', '/w/app')).toEqual(['/w/app']);
  });

  it('walks to the root outside a repository', () => {
    expect(trustCandidates('/w/notes/', null, null)).toEqual(['/w/notes', '/w', '/']);
  });
});

describe('waiting tasks', () => {
  it('reports changes once, and only real ones', () => {
    const seen: Array<[number, boolean]> = [];
    const off = onTrustWaiting((id, w) => seen.push([id, w]));
    setTrustWaiting(7, true);
    setTrustWaiting(7, true);
    expect(isTrustWaiting(7)).toBe(true);
    setTrustWaiting(7, false);
    off();
    setTrustWaiting(7, true);
    expect(seen).toEqual([
      [7, true],
      [7, false],
    ]);
    setTrustWaiting(7, false);
  });
});
