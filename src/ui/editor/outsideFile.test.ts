/**
 * The decision behind opening a file outside the worktree (#143): inside opens
 * as ever; outside opens only once granted, and a grant is asked for only when
 * the request carries a click. Refusals come back from Rust with a kind.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  asRefusal,
  decideOpen,
  grantOutsideFile,
  isUserActivated,
  markUserActivated,
  refusalText,
  resetOutsideGrants,
  type DecideDeps,
  type GrantResult,
} from './outsideFile';

const WT = '/Users/me/agents/repo/task-1';
const OUTSIDE = '/Users/me/code/other-repo/config.tf';

function deps(inside: boolean, grant: GrantResult): DecideDeps & { grant: ReturnType<typeof vi.fn> } {
  return {
    resolveInside: vi.fn(async (root: string, raw: string) => (inside ? { absolute: `${root}/${raw}`, relative: raw } : null)),
    grant: vi.fn(async () => grant),
  };
}

const ok: GrantResult = { ok: true, absolute: OUTSIDE };
const refused = (kind: 'missing' | 'unreadable' | 'denied' | 'directory', message = 'x'): GrantResult => ({
  ok: false,
  refusal: { kind, path: OUTSIDE, message },
});

afterEach(() => resetOutsideGrants());

describe('decideOpen', () => {
  it('opens a path inside the worktree as before, granting nothing', async () => {
    const d = deps(true, ok);
    const got = await decideOpen(WT, 'src/a.ts', true, d);
    expect(got).toEqual({ kind: 'inside', target: { absolute: `${WT}/src/a.ts`, relative: 'src/a.ts' } });
    expect(d.grant).not.toHaveBeenCalled();
  });

  it('grants and opens an outside path when the request carries a click', async () => {
    const d = deps(false, ok);
    expect(await decideOpen(WT, OUTSIDE, true, d)).toEqual({ kind: 'outside', absolute: OUTSIDE });
    expect(d.grant).toHaveBeenCalledWith(WT, OUTSIDE);
  });

  it('asks instead of granting when nobody clicked: a restored tab, a render', async () => {
    const d = deps(false, ok);
    expect(await decideOpen(WT, OUTSIDE, false, d)).toEqual({ kind: 'ask', path: OUTSIDE });
    expect(d.grant).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', 'does not exist'],
    ['unreadable', 'permission denied'],
    ['denied', 'Albedo does not open files under /Users/me/.ssh: it holds keys or credentials'],
    ['directory', 'is a folder, not a file'],
  ] as const)('passes a %s refusal through', async (kind, message) => {
    const d = deps(false, refused(kind, message));
    expect(await decideOpen(WT, OUTSIDE, true, d)).toEqual({
      kind: 'refused',
      refusal: { kind, path: OUTSIDE, message },
    });
  });

  it('reopens a file granted earlier in this run without a new grant or a click', async () => {
    const invoke = vi.fn(async () => OUTSIDE) as unknown as Parameters<typeof grantOutsideFile>[2];
    await grantOutsideFile(WT, OUTSIDE, invoke);
    const d = deps(false, ok);
    expect(await decideOpen(WT, OUTSIDE, false, d)).toEqual({ kind: 'outside', absolute: OUTSIDE });
    expect(d.grant).not.toHaveBeenCalled();
    // Keyed by worktree: another task's tab still asks.
    expect(await decideOpen('/Users/me/agents/repo/task-2', OUTSIDE, false, d)).toEqual({ kind: 'ask', path: OUTSIDE });
  });
});

describe('grantOutsideFile', () => {
  it('asks Rust for the path as given, relative to the worktree, and returns its canonical answer', async () => {
    const invoke = vi.fn(async () => '/private/tmp/real.txt');
    const got = await grantOutsideFile(WT, ' ../tmp-link.txt ', invoke as never);
    expect(invoke).toHaveBeenCalledWith('allow_outside_file', { path: '../tmp-link.txt', base: WT });
    expect(got).toEqual({ ok: true, absolute: '/private/tmp/real.txt' });
  });

  it('turns a Rust refusal into its kind, and anything else into unreadable', async () => {
    const denied = { kind: 'denied', path: '/Users/me/.ssh/id_ed25519', message: 'no' };
    expect(await grantOutsideFile(WT, '~/.ssh/id_ed25519', vi.fn(async () => Promise.reject(denied)) as never)).toEqual({
      ok: false,
      refusal: denied,
    });
    const failed = await grantOutsideFile(WT, OUTSIDE, vi.fn(async () => Promise.reject(new Error('boom'))) as never);
    expect(failed).toEqual({ ok: false, refusal: { kind: 'unreadable', path: OUTSIDE, message: 'boom' } });
    // A refusal is not remembered: the next click asks again.
    const d = deps(false, ok);
    expect((await decideOpen(WT, OUTSIDE, false, d)).kind).toBe('ask');
  });
});

describe('the click, carried on the request object', () => {
  it('marks only the exact object, so a copy (a restored tab) carries no click', () => {
    const req = { path: OUTSIDE };
    markUserActivated(req);
    expect(isUserActivated(req)).toBe(true);
    expect(isUserActivated({ ...req })).toBe(false);
    expect(isUserActivated({ path: OUTSIDE })).toBe(false);
    expect(isUserActivated(null)).toBe(false);
  });
});

describe('refusal wording', () => {
  it('says each plainly', () => {
    expect(refusalText({ kind: 'missing', path: OUTSIDE, message: 'does not exist' })).toBe(`${OUTSIDE} does not exist.`);
    expect(refusalText({ kind: 'directory', path: '/Users/me/code', message: '' })).toBe('/Users/me/code is a folder, not a file.');
    expect(refusalText({ kind: 'unreadable', path: OUTSIDE, message: 'permission denied' })).toBe(
      `${OUTSIDE} can’t be read: permission denied.`,
    );
    expect(
      refusalText({
        kind: 'denied',
        path: '/Users/me/.ssh/id_ed25519',
        message: 'Albedo does not open files under /Users/me/.ssh: it holds keys or credentials',
      }),
    ).toBe('Albedo does not open files under /Users/me/.ssh: it holds keys or credentials.');
    expect(asRefusal({ kind: 'nonsense', message: 'x' }, OUTSIDE).kind).toBe('unreadable');
  });
});
