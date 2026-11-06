/**
 * #272: which file a question points to, reading it, and the answer a set of
 * comments becomes.
 */
import { describe, expect, it, vi } from 'vitest';
import { composeComments, isRecommended, planPathIn, readPlanFile, reviseLabel, sizeText, splitPath } from './planDoc';

describe('planPathIn', () => {
  it('finds an absolute .md path in prose, without the sentence’s punctuation', () => {
    expect(planPathIn('Full plan: /private/tmp/x/scratchpad/plan-ABC-1234.md. Proceed?')).toBe(
      '/private/tmp/x/scratchpad/plan-ABC-1234.md',
    );
    expect(planPathIn('See `/tmp/plan.md`')).toBe('/tmp/plan.md');
    expect(planPathIn('(written to /tmp/a/PLAN.MD)')).toBe('/tmp/a/PLAN.MD');
    expect(planPathIn('/tmp/start.md is where it is')).toBe('/tmp/start.md');
  });

  it('takes the first of several', () => {
    expect(planPathIn('Plan: /tmp/one.md, notes: /tmp/two.md')).toBe('/tmp/one.md');
  });

  it('ignores relative paths, ~ paths, other extensions and URLs', () => {
    expect(planPathIn('docs/plan.md and ./plan.md')).toBeNull();
    expect(planPathIn('~/plans/plan.md')).toBeNull();
    expect(planPathIn('/tmp/plan.mdx /tmp/plan.txt /tmp/plan.md.bak')).toBeNull();
    expect(planPathIn('https://example.com/docs/plan.md')).toBeNull();
    expect(planPathIn('//host/share/plan.md')).toBeNull();
    expect(planPathIn('no path at all')).toBeNull();
  });

  it('a later valid path still counts after an invalid one', () => {
    expect(planPathIn('https://example.com/a.md then /tmp/b.md')).toBe('/tmp/b.md');
  });
});

describe('splitPath', () => {
  it('splits the name from its folder', () => {
    expect(splitPath('/tmp/x/plan.md')).toEqual({ name: 'plan.md', folder: '/tmp/x/' });
  });
});

describe('readPlanFile', () => {
  it('reads through read_plan_file, with that one path', async () => {
    const invoke = vi.fn(async () => ({ path: '/private/tmp/plan.md', text: '# Plan', size: 6, truncated: false }));
    const got = await readPlanFile('/tmp/plan.md', invoke as never);
    expect(invoke).toHaveBeenCalledWith('read_plan_file', { path: '/tmp/plan.md' });
    expect(got).toEqual({ path: '/private/tmp/plan.md', text: '# Plan', size: 6, truncated: false });
  });

  it('a missing or refused file is null: no document', async () => {
    const invoke = vi.fn(async () => {
      throw { kind: 'missing', path: '/tmp/gone.md', message: 'does not exist' };
    });
    expect(await readPlanFile('/tmp/gone.md', invoke as never)).toBeNull();
  });

  it('never asks for anything but an absolute .md path', async () => {
    const invoke = vi.fn();
    expect(await readPlanFile('plan.md', invoke as never)).toBeNull();
    expect(await readPlanFile('/tmp/secrets.env', invoke as never)).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('passes on that the file was cut at the cap', async () => {
    const invoke = vi.fn(async () => ({ path: '/tmp/big.md', text: 'head', size: 900_000, truncated: true }));
    expect(await readPlanFile('/tmp/big.md', invoke as never)).toMatchObject({ truncated: true, size: 900_000 });
    expect(sizeText(256 * 1024)).toBe('256 KB');
    expect(sizeText(900_000)).toBe('879 KB');
    expect(sizeText(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('options', () => {
  it('only a label ending "(Recommended)" is the suggestion', () => {
    expect(isRecommended('Approve (Recommended)')).toBe(true);
    expect(isRecommended('Approve (recommended) ')).toBe(true);
    expect(isRecommended('Approve')).toBe(false);
    expect(isRecommended('(Recommended) Approve')).toBe(false);
  });

  it('comments answer as the option that asks for changes, else Revise', () => {
    expect(reviseLabel(['Approve', 'Revise'])).toBe('Revise');
    expect(reviseLabel(['Approve', 'Request changes (Recommended)'])).toBe('Request changes');
    expect(reviseLabel(['Go', 'Change the plan'])).toBe('Change the plan');
    expect(reviseLabel(['Go', 'Feedback'])).toBe('Feedback');
    expect(reviseLabel(['Approve with edits', 'Stop'])).toBe('Revise');
    expect(reviseLabel(['Yes', 'No'])).toBe('Revise');
  });
});

describe('composeComments', () => {
  it('is exactly the approved shape', () => {
    expect(
      composeComments('Revise', 'plan-ABC-1234.md', [
        { quote: 'Non-staff callers: the key is absent.', comment: 'Should non-staff get an empty list rather than no key? Clients check for the key.' },
        { quote: 'new dumpTags()', comment: 'Reuse the serializer list_items already has instead of a new dump method.' },
      ]),
    ).toBe(
      [
        'Revise. Comments on the plan (plan-ABC-1234.md):',
        '',
        '1. On "Non-staff callers: the key is absent.":',
        '   Should non-staff get an empty list rather than no key? Clients check for the key.',
        '',
        '2. On "new dumpTags()":',
        '   Reuse the serializer list_items already has instead of a new dump method.',
      ].join('\n'),
    );
  });

  it('puts a passage on one line and indents every line of a comment', () => {
    expect(composeComments('Keep Planning', null, [{ quote: 'a\n  b', comment: ' one\ntwo \n' }])).toBe(
      'Keep Planning. Comments on the plan:\n\n1. On "a b":\n   one\n   two',
    );
  });
});
