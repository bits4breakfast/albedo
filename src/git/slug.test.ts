import { describe, expect, it } from 'vitest';
import {
  MAX_SLUG_LENGTH,
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
