/**
 * "Since your review"'s explanation (#352): what the one call is sent -- the
 * commit messages and the diff between the two heads, cut to a cap and said
 * so -- and what is kept of the answer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHANGES_DIFF_MAX_CHARS,
  CHANGES_MAX_CHARS,
  changesPrompt,
  GuideError,
  setOneshotRunner,
  writeChangesExplanation,
  type OneshotRequest,
} from './writer';

const commit = { sha: 'f'.repeat(40), subject: 'Cap retries at 5', body: 'As asked in review.' };

describe('changesPrompt', () => {
  it('sends the messages and the diff whole when they fit', () => {
    const { prompt, cut } = changesPrompt({ commits: [commit], diff: '+max_attempts = 5\n', forced: false });
    expect(cut).toBe(false);
    expect(prompt).toContain('- fffffff Cap retries at 5\n  As asked in review.');
    expect(prompt).toContain('+max_attempts = 5');
    expect(prompt).not.toContain('force-pushed');
    expect(prompt).not.toContain('cut');
  });

  it('cuts a long diff at a line, and says how much was left out', () => {
    const line = `+${'x'.repeat(99)}\n`;
    const diff = line.repeat(Math.ceil(CHANGES_DIFF_MAX_CHARS / line.length) + 10);
    const { prompt, cut } = changesPrompt({ commits: [commit], diff, forced: true });
    expect(cut).toBe(true);
    expect(prompt.length).toBeLessThan(CHANGES_DIFF_MAX_CHARS + 2_000);
    expect(prompt).toMatch(/\[… the diff was cut here: \d+ more lines not shown …\]$/);
    expect(prompt).toContain('(cut to fit; see its end)');
    expect(prompt).toContain('force-pushed');
  });
});

describe('writeChangesExplanation', () => {
  let prev: ReturnType<typeof setOneshotRunner> | null = null;
  afterEach(() => {
    if (prev) setOneshotRunner(prev);
  });
  const result = (structured: unknown) => ({
    code: 0,
    stdout: JSON.stringify({ type: 'result', is_error: false, structured_output: structured }),
    stderr: '',
    timedOut: false,
  });

  it('keeps the answer as one paragraph, capped', async () => {
    const asked: OneshotRequest[] = [];
    prev = setOneshotRunner(async (req) => {
      asked.push(req);
      return result({ explanation: `  Retries stop at five.\n\nThe log says which.  ${'y'.repeat(CHANGES_MAX_CHARS)}` });
    });
    const out = await writeChangesExplanation({ commits: [commit], diff: '+a\n', forced: false });
    expect(out.cut).toBe(false);
    expect(out.text.startsWith('Retries stop at five. The log says which.')).toBe(true);
    expect(out.text.length).toBe(CHANGES_MAX_CHARS);
    expect(JSON.parse(asked[0]!.jsonSchema).required).toEqual(['explanation']);
  });

  it('an empty answer is an error, not an empty explanation', async () => {
    prev = setOneshotRunner(async () => result({ explanation: '  ' }));
    await expect(writeChangesExplanation({ commits: [], diff: '', forced: false })).rejects.toBeInstanceOf(GuideError);
  });
});
