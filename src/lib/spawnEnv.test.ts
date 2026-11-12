/**
 * Hard rule 3 for the shell-plugin runners (#360): git runs hooks and gh runs
 * extensions, so neither may inherit the Anthropic credentials. These drive the
 * production runners (no injected fake) against a mocked plugin and check the
 * options they spawn with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const created: Array<{ program: string; args: string[]; options: Record<string, unknown> | undefined }> = [];

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: (program: string, args: string[], options?: Record<string, unknown>) => {
      created.push({ program, args, options });
      return { execute: async () => ({ code: 0, stdout: '', stderr: '' }) };
    },
  },
}));

import { BLANKED_ANTHROPIC_ENV, withoutAnthropicKeys } from './spawnEnv';
import { git } from '../git/worktree';
import { gh } from '../gh/gh';

beforeEach(() => {
  created.length = 0;
});
afterEach(() => {
  created.length = 0;
});

describe('withoutAnthropicKeys', () => {
  it('blanks both credentials and keeps everything else', () => {
    expect(withoutAnthropicKeys({ A: '1' })).toEqual({ A: '1', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' });
    expect(withoutAnthropicKeys()).toEqual({ ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' });
  });

  it('cannot be undone by the env it is given', () => {
    const env = withoutAnthropicKeys({ ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_AUTH_TOKEN: 't' });
    expect(env.ANTHROPIC_API_KEY).toBe('');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('');
  });

  it('is frozen, so no caller can weaken it for everyone', () => {
    expect(Object.isFrozen(BLANKED_ANTHROPIC_ENV)).toBe(true);
  });
});

describe('git runner', () => {
  it('blanks the credentials with no cwd and no env', async () => {
    await git(['status']);
    expect(created).toHaveLength(1);
    expect(created[0]!.program).toBe('git');
    expect(created[0]!.args).toEqual(['status']);
    expect(created[0]!.options).toEqual({ env: { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' } });
  });

  it('keeps the cwd and the caller env, and the caller cannot restore a key', async () => {
    await git(['worktree', 'add', 'x'], '/repo', { GIT_TERMINAL_PROMPT: '0', ANTHROPIC_API_KEY: 'sk-x' });
    expect(created[0]!.options).toEqual({
      cwd: '/repo',
      env: { GIT_TERMINAL_PROMPT: '0', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' },
    });
  });
});

describe('gh runner', () => {
  it('keeps its own env and blanks the credentials', async () => {
    const r = await gh(['pr', 'list'], '/repo');
    expect(r).not.toBeNull();
    expect(created[0]!.args).toEqual(['pr', 'list']);
    expect(created[0]!.options).toEqual({
      cwd: '/repo',
      env: {
        GH_PROMPT_DISABLED: '1',
        NO_COLOR: '1',
        GH_PAGER: 'cat',
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
      },
    });
  });

  it('blanks them without a cwd too', async () => {
    await gh(['api', 'user']);
    expect(created[0]!.options).toEqual({
      env: {
        GH_PROMPT_DISABLED: '1',
        NO_COLOR: '1',
        GH_PAGER: 'cat',
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
      },
    });
  });
});
