import { describe, expect, it } from 'vitest';
import {
  MAX_SLUG_LENGTH,
  nameTask,
  assertValidRefName,
  branchNameFor,
  isSafeSlug,
  isValidRefName,
  slugify,
} from './slug';

describe('slugify', () => {
  it('lowercases and dashes ordinary titles', () => {
    expect(slugify('Fix the login bug')).toBe('fix-the-login-bug');
    expect(slugify('Add OAuth2 Support')).toBe('add-oauth2-support');
  });

  it('collapses and trims separator runs', () => {
    expect(slugify('  hello   ---  world  ')).toBe('hello-world');
    expect(slugify('__a__b__')).toBe('a-b');
    expect(slugify('---')).toMatch(/^task-\d+$/);
  });

  it('strips punctuation that git or the filesystem would choke on', () => {
    // Every one of these is either a git ref metacharacter or a shell one.
    expect(slugify('feat: add ~caret^ and :colon?')).toBe('feat-add-caret-and-colon');
    expect(slugify('a/b\\c')).toBe('a-b-c');
    expect(slugify('what about [brackets] and *stars*')).toBe('what-about-brackets-and-stars');
    expect(slugify('drop table; rm -rf /')).toBe('drop-table-rm-rf');
    expect(slugify('back`tick` and $dollar')).toBe('back-tick-and-dollar');
  });

  it('never produces a git-illegal ref name', () => {
    expect(slugify('.hidden')).toBe('hidden');
    expect(slugify('trailing.')).toBe('trailing');
    expect(slugify('a..b')).toBe('a-b');
    expect(slugify('ref@{0}')).toBe('ref-0');
    expect(slugify('index.lock')).toBe('index-lock');
    expect(slugify('-leading dash')).toBe('leading-dash');
    expect(slugify('trailing dash -')).toBe('trailing-dash');
    expect(slugify('@')).toMatch(/^task-\d+$/);
  });

  it('folds accents rather than dropping the word', () => {
    expect(slugify('Café résumé')).toBe('cafe-resume');
    expect(slugify('naïve Ångström')).toBe('naive-angstrom');
  });

  it('caps length and does not leave a trailing dash at the cut', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long)).toHaveLength(MAX_SLUG_LENGTH);

    // The cut lands exactly past a dash: it must be trimmed, not kept.
    const title = `${'b'.repeat(MAX_SLUG_LENGTH)} tail`;
    const s = slugify(title);
    expect(s).toBe('b'.repeat(MAX_SLUG_LENGTH));
    expect(s.endsWith('-')).toBe(false);

    expect(slugify('one two three', { maxLength: 7 })).toBe('one-two');
  });

  it('falls back to a timestamped slug when nothing survives', () => {
    expect(slugify('', { now: 1700000000000 })).toBe('task-1700000000000');
    expect(slugify('   ', { now: 1 })).toBe('task-1');
    expect(slugify('日本語', { now: 2 })).toBe('task-2');
    expect(slugify('!!!', { now: 3 })).toBe('task-3');
    // @ts-expect-error -- defensive: the UI can hand us undefined mid-typing.
    expect(slugify(undefined, { now: 4 })).toBe('task-4');
  });

  it('always returns something isSafeSlug accepts', () => {
    const titles = [
      'Fix the login bug',
      '...',
      '-',
      'a'.repeat(200),
      'ünïcödé',
      'a/b',
      '@{',
      '.lock',
      'CAPS AND 123',
      '   spaces   ',
      'tab\there',
      'new\nline',
      'nul\u0000byte',
    ];
    for (const t of titles) {
      expect(isSafeSlug(slugify(t, { now: 5 })), t).toBe(true);
    }
  });
});

describe('isSafeSlug', () => {
  it('accepts well-formed slugs', () => {
    expect(isSafeSlug('a')).toBe(true);
    expect(isSafeSlug('fix-login')).toBe(true);
    expect(isSafeSlug('task-1700000000000')).toBe(true);
  });

  it('rejects anything a branch name must not be', () => {
    const bad = [
      '',
      '-a',
      'a-',
      'A',
      'a_b',
      'a.b',
      'a b',
      'a/b',
      '..',
      'a..b',
      'x.lock',
      '.git',
      'a@{b',
    ];
    for (const b of bad) expect(isSafeSlug(b), b).toBe(false);
  });
});

describe('branchNameFor', () => {
  it('mirrors the slug so the ref and the directory match', () => {
    expect(branchNameFor('fix-login')).toBe('fix-login');
  });
  it('refuses an unsafe slug rather than handing it to git', () => {
    expect(() => branchNameFor('-rf')).toThrow(/unsafe slug/);
  });
});

describe('isValidRefName', () => {
  it('accepts real-world branch names', () => {
    for (const ok of ['main', 'origin/main', 'feature/JIRA-123_thing', 'v1.2.x', 'a']) {
      expect(isValidRefName(ok), ok).toBe(true);
    }
  });

  it('rejects option-like and git-illegal names', () => {
    const bad = [
      '',
      '-b',
      '--upload-pack=touch /tmp/pwn',
      '/main',
      'main/',
      'a//b',
      '.a',
      'a.',
      'a..b',
      'a@{0}',
      '@',
      'a.lock',
      'feature/.hidden',
      'a b',
      'a~1',
      'a^',
      'a:b',
      'a?',
      'a*',
      'a[1]',
      'a\\b',
      'a\tb',
      'a\u0000b',
    ];
    for (const b of bad) expect(isValidRefName(b), b).toBe(false);
  });

  it('assertValidRefName throws with the offending value', () => {
    expect(() => assertValidRefName('-b', 'base branch')).toThrow(/Invalid base branch name/);
    expect(() => assertValidRefName('main')).not.toThrow();
  });
});

describe('nameTask', () => {
  it('reproduces the branches already on the user machine', () => {
    expect(nameTask('UP-2398')).toEqual({
      key: 'UP-2398',
      slug: 'UP-2398',
      branch: 'UP-2398',
      dirName: 'UP-2398',
    });
    expect(nameTask('UP-2398-followup')).toMatchObject({
      key: 'UP-2398',
      branch: 'UP-2398-followup',
      dirName: 'UP-2398',
    });
    expect(nameTask('PLATFORM-19T')).toMatchObject({ branch: 'PLATFORM-19T' });
    expect(nameTask('HUB-429902396650')).toMatchObject({ branch: 'HUB-429902396650' });
  });

  it('slugs the part after the key onto the branch', () => {
    expect(nameTask('UP-2398 fix the login loop')).toMatchObject({
      key: 'UP-2398',
      branch: 'UP-2398-fix-the-login-loop',
      dirName: 'UP-2398',
    });
    expect(nameTask('UP-2398: Fix The Login Loop')).toMatchObject({
      branch: 'UP-2398-fix-the-login-loop',
    });
  });

  it('keys the directory on the issue alone — one worktree per issue', () => {
    // Two tasks naming one issue therefore collide on the path, which
    // createWorktree refuses. That is the intended answer.
    expect(nameTask('UP-2398 part one').dirName).toBe('UP-2398');
    expect(nameTask('UP-2398 part two').dirName).toBe('UP-2398');
  });

  it('leaves keyless titles exactly as they were', () => {
    expect(nameTask('Fix the login loop')).toEqual({
      key: null,
      slug: 'fix-the-login-loop',
      branch: 'fix-the-login-loop',
      dirName: 'fix-the-login-loop',
    });
    expect(nameTask('UTF-8 encoding is broken')).toMatchObject({
      key: null,
      branch: 'utf-8-encoding-is-broken',
    });
  });

  it('falls back to the bare key when the rest slugs to nothing', () => {
    // "UP-2398 !!!" must not become `UP-2398-task-1700000000000`.
    expect(nameTask('UP-2398 !!!', { now: 1700000000000 })).toMatchObject({
      branch: 'UP-2398',
      dirName: 'UP-2398',
    });
    expect(nameTask('UP-2398 \u65e5\u672c\u8a9e', { now: 1 })).toMatchObject({ branch: 'UP-2398' });
  });

  it('still produces a usable name for an empty title', () => {
    expect(nameTask('', { now: 7 })).toEqual({
      key: null,
      slug: 'task-7',
      branch: 'task-7',
      dirName: 'task-7',
    });
  });

  it('always produces a legal ref name and a legal directory name', () => {
    const titles = [
      'UP-2398', 'UP-2398 fix', 'UP-2398-followup', 'PLATFORM-19T', 'HUB-429902396650',
      'Fix the thing', '', '...', 'a'.repeat(200), 'UP-2398 ' + 'x'.repeat(200),
      'UTF-8 encoding', 'E-mail the team', '-leading dash',
    ];
    for (const t of titles) {
      const n = nameTask(t, { now: 9 });
      expect(isValidRefName(n.branch), `${t} -> ${n.branch}`).toBe(true);
      expect(n.dirName.startsWith('-'), t).toBe(false);
      expect(n.dirName.length > 0, t).toBe(true);
      expect(n.dirName.includes('/'), t).toBe(false);
    }
  });
});
