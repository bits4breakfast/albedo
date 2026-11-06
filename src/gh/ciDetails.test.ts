/**
 * A queued CI failure's details (#280, step 2), the pure half: the command's
 * input and output, the 40-line / 4 KB limits, and the lines the message
 * carries.
 */

import { describe, expect, it } from 'vitest';
import {
  DETAIL_MAX_BYTES,
  DETAIL_TAIL_LINES,
  clipLog,
  cleanLines,
  commandInput,
  exitReason,
  failedDetailsLine,
  formatCheckDetail,
  parseCommandOutput,
} from './ciDetails';

const SHA = 'abc1234def5678900000000000000000000000aa';
const failure = {
  prNumber: 14,
  sha: SHA,
  checks: [
    { name: 'build', conclusion: 'failed', url: 'https://ci.example/job/812' },
    { name: 'lint', conclusion: 'timed out', url: null },
  ],
};

describe('the command’s input', () => {
  it('is the PR, the head commit and each failing check’s name, conclusion and link', () => {
    expect(commandInput(failure)).toEqual({
      pr: 14,
      head: SHA,
      checks: [
        { name: 'build', conclusion: 'failed', link: 'https://ci.example/job/812' },
        { name: 'lint', conclusion: 'timed out', link: null },
      ],
    });
  });

  it('gives an empty head when GitHub named no commit', () => {
    expect(commandInput({ ...failure, sha: '#14' }).head).toBe('');
  });
});

describe('the command’s output', () => {
  const names = ['build', 'lint'];

  it('reads step and log per check, by name, in the queue’s order', () => {
    const out = JSON.stringify({
      checks: [
        { name: 'lint', step: 'eslint', log: 'a.ts:1 no-unused-vars' },
        { name: 'build', step: 'Run tests', log: 'FAIL fractions.test.ts\n  Expected: "⅓ cup"\n  Received: "0.33 cup"\n' },
      ],
    });
    expect(parseCommandOutput(out, names)).toEqual({
      ok: true,
      checks: [
        { name: 'build', step: 'Run tests', log: ['FAIL fractions.test.ts', '  Expected: "⅓ cup"', '  Received: "0.33 cup"'], more: 0 },
        { name: 'lint', step: 'eslint', log: ['a.ts:1 no-unused-vars'], more: 0 },
      ],
    });
  });

  it('ignores checks that are not failing, unknown fields, a second entry for a name, and malformed entries', () => {
    const out = JSON.stringify({
      extra: true,
      checks: [
        { name: 'deploy', step: 'x', log: 'not ours' },
        null,
        'build',
        { name: 'build', step: 'Run tests', colour: 'red' },
        { name: 'build', step: 'Second' },
      ],
    });
    expect(parseCommandOutput(out, names)).toEqual({ ok: true, checks: [{ name: 'build', step: 'Run tests', log: [], more: 0 }] });
  });

  it('takes a log given as a list of lines, and an empty step as none', () => {
    const out = JSON.stringify({ checks: [{ name: 'build', step: '  ', log: ['one', 'two'] }] });
    expect(parseCommandOutput(out, names)).toEqual({ ok: true, checks: [{ name: 'build', step: null, log: ['one', 'two'], more: 0 }] });
  });

  it('cleans what it prints to plain text: no escapes, no control characters', () => {
    const out = JSON.stringify({ checks: [{ name: 'build', step: '\u001b[1mRun\u001b[0m tests', log: '\u001b[31mred\u001b[0m\u0007 bell' }] });
    expect(parseCommandOutput(out, names)).toEqual({ ok: true, checks: [{ name: 'build', step: 'Run tests', log: ['red bell'], more: 0 }] });
  });

  it('says why when the output cannot be used', () => {
    expect(parseCommandOutput('', names)).toEqual({ ok: false, reason: 'the command printed nothing' });
    expect(parseCommandOutput('build failed, see link', names)).toEqual({ ok: false, reason: 'its output is not JSON' });
    expect(parseCommandOutput('[]', names)).toEqual({ ok: false, reason: 'its output has no "checks" list' });
    expect(parseCommandOutput('{"checks": {}}', names)).toEqual({ ok: false, reason: 'its output has no "checks" list' });
    expect(parseCommandOutput('null', names)).toEqual({ ok: false, reason: 'its output has no "checks" list' });
    expect(parseCommandOutput('{"checks": [{"name": "deploy"}]}', names)).toEqual({
      ok: false,
      reason: 'its output names none of the failing checks',
    });
  });

  it('names an exit by its code and the first thing the command said', () => {
    expect(exitReason(2, '\n  circleci: token missing\nusage: …')).toBe('the command exited with 2: circleci: token missing');
    expect(exitReason(1, '')).toBe('the command exited with 1');
    expect(exitReason(null, '')).toBe('the command was stopped');
    expect(exitReason(1, 'x'.repeat(300))).toHaveLength('the command exited with 1: '.length + 121);
  });
});

describe('the limits: the last 40 lines, at most 4 KB, cut from the top', () => {
  it('keeps a short log whole', () => {
    expect(clipLog(['a', 'b'])).toEqual({ log: ['a', 'b'], more: 0 });
  });

  it('keeps the last 40 lines and counts the rest', () => {
    const lines = Array.from({ length: 317 }, (_, i) => `line ${i + 1}`);
    const { log, more } = clipLog(lines);
    expect(log).toHaveLength(DETAIL_TAIL_LINES);
    expect(log[0]).toBe('line 278');
    expect(log.at(-1)).toBe('line 317');
    expect(more).toBe(277);
  });

  it('keeps fewer lines when 40 would be over 4 KB, the end always', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `${String(i + 1).padStart(2, '0')} ${'x'.repeat(300)}`);
    const { log, more } = clipLog(lines);
    const size = new TextEncoder().encode(log.join('\n')).length;
    expect(size).toBeLessThanOrEqual(DETAIL_MAX_BYTES);
    expect(log.length).toBe(13); // 13 × 304 bytes + 12 newlines = 3,964
    expect(log.at(-1)).toMatch(/^40 /);
    expect(more).toBe(27);
  });

  it('measures bytes, not characters', () => {
    const wide = Array.from({ length: 40 }, () => '⅓'.repeat(100)); // 300 bytes a line
    const { log } = clipLog(wide);
    expect(new TextEncoder().encode(log.join('\n')).length).toBeLessThanOrEqual(DETAIL_MAX_BYTES);
    expect(log.length).toBe(13);
  });

  it('drops trailing blank lines before counting', () => {
    expect(clipLog(['a', 'b', '', '  ', ''])).toEqual({ log: ['a', 'b'], more: 0 });
  });

  it('cuts a command’s very long line, as a job log’s is', () => {
    const [line] = cleanLines('y'.repeat(5000));
    expect(line!.length).toBeLessThan(500);
    expect(clipLog(cleanLines(`${'y'.repeat(5000)}\nend`)).log).toHaveLength(2);
  });
});

describe('the lines the message carries', () => {
  it('adds the step and the log, indented under the check', () => {
    expect(formatCheckDetail({ name: 'build', step: 'Run tests', log: ['FAIL a', '  Expected 1'], more: 38 })).toEqual([
      '  step: Run tests',
      '  log (last 2 lines):',
      '    FAIL a',
      '      Expected 1',
    ]);
  });

  it('says "log:" when nothing was cut, and leaves out what is not there', () => {
    expect(formatCheckDetail({ name: 'build', step: null, log: ['only'], more: 0 })).toEqual(['  log:', '    only']);
    expect(formatCheckDetail({ name: 'lint', step: 'eslint', log: [], more: 0 })).toEqual(['  step: eslint']);
  });

  it('says why there are none in one line', () => {
    expect(failedDetailsLine('the command took longer than 30 s')).toBe(
      'Details could not be fetched: the command took longer than 30 s.',
    );
  });
});
