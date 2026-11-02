/**
 * The writer, with an injected runner: no real `claude` ever runs here. The
 * outputs below are shaped as measured on Claude Code 2.1.316 (writer.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBranchDiff, type BranchDiff } from './blocks';
import { estimateTokens, renderBlock, statReason, SUMMARY_LINE_TOKENS } from './budget';
import { edited } from './fixtures';
import { CALL_OVERHEAD_TOKENS, findResult, GuideError, setOneshotRunner, writeGuide, type OneshotOutput, type OneshotRequest } from './writer';

const ok = (structured: unknown, extra: Record<string, unknown> = {}): OneshotOutput => ({
  code: 0,
  stdout: `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(structured), structured_output: structured, ...extra })}\n`,
  stderr: '',
  timedOut: false,
});

function diffOf(...paths: string[]): BranchDiff {
  return buildBranchDiff(paths.map((p) => edited(p, [3])), statReason);
}

let prev: ReturnType<typeof setOneshotRunner> | null = null;
function useRunner(fn: (req: OneshotRequest) => OneshotOutput | Promise<OneshotOutput>) {
  const calls: OneshotRequest[] = [];
  prev = setOneshotRunner(async (req) => {
    calls.push(req);
    return fn(req);
  });
  return calls;
}
afterEach(() => {
  if (prev) setOneshotRunner(prev);
  prev = null;
  vi.restoreAllMocks();
});

async function failure(p: Promise<unknown>): Promise<GuideError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(GuideError);
    return err as GuideError;
  }
  throw new Error('expected a GuideError');
}

describe('writeGuide, one call', () => {
  it('asks once with every block, and keeps the validated groups with the diff hash', async () => {
    const diff = diffOf('src/a.ts', 'src/b.ts');
    const [a, b] = diff.order;
    const calls = useRunner(() => ok({ groups: [{ title: 'Both', summary: 'Does it.', blocks: [b, a] }] }));
    const guide = await writeGuide(diff, { base: 'main', now: () => 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain(`[${a}] src/a.ts`);
    expect(JSON.parse(calls[0]!.jsonSchema).required).toEqual(['groups']);
    expect(guide).toMatchObject({
      diffHash: diff.hash,
      writtenAt: 42,
      base: 'main',
      fallback: null,
      groups: [{ title: 'Both', summary: 'Does it.', blocks: [b, a] }],
    });
  });

  it('reads the reply text when there is no structured output, fences and all', async () => {
    const diff = diffOf('a.ts');
    const reply = { groups: [{ title: 'T', summary: 'S', blocks: diff.order }] };
    useRunner(() => ({
      code: 0,
      stdout: JSON.stringify({ type: 'result', is_error: false, result: `\`\`\`json\n${JSON.stringify(reply)}\n\`\`\`` }),
      stderr: '',
      timedOut: false,
    }));
    expect((await writeGuide(diff, { base: 'main' })).groups[0]!.title).toBe('T');
  });

  it('skips what a login shell’s profile printed before the result', () => {
    const line = JSON.stringify({ type: 'result', is_error: false, result: '{}' });
    expect(findResult(`Welcome back!\n{not json\n${line}\n`)).toMatchObject({ type: 'result' });
    expect(findResult('nothing here')).toBeNull();
  });

  it('drops ids the diff does not have; what no group named stays for Unsorted', async () => {
    const diff = diffOf('a.ts', 'b.ts');
    const [a] = diff.order;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    useRunner(() => ok({ groups: [{ title: 'T', summary: 'S', blocks: [a, 'zzzz'] }] }));
    const guide = await writeGuide(diff, { base: 'main' });
    expect(guide.groups).toEqual([{ title: 'T', summary: 'S', blocks: [a] }]);
  });
});

describe('writeGuide, errors: said, never a partial guide', () => {
  const diff = diffOf('a.ts');

  it('Claude Code missing', async () => {
    useRunner(() => ({ code: 127, stdout: '', stderr: 'zsh:1: command not found: claude', timedOut: false }));
    expect((await failure(writeGuide(diff, { base: 'main' }))).kind).toBe('missing');
  });

  it('a timeout', async () => {
    useRunner(() => ({ code: null, stdout: '', stderr: '', timedOut: true }));
    expect((await failure(writeGuide(diff, { base: 'main' }))).kind).toBe('timeout');
  });

  it('an error result says what Claude Code said', async () => {
    useRunner(() => ({
      code: 1,
      stdout: JSON.stringify({ type: 'result', is_error: true, result: 'There’s an issue with the selected model.' }),
      stderr: '',
      timedOut: false,
    }));
    const e = await failure(writeGuide(diff, { base: 'main' }));
    expect(e.kind).toBe('failed');
    expect(e.message).toMatch(/selected model/);
  });

  it('invalid JSON, the wrong shape, or no known block at all', async () => {
    useRunner(() => ({ code: 0, stdout: JSON.stringify({ type: 'result', result: 'Sure! Here are groups.' }), stderr: '', timedOut: false }));
    expect((await failure(writeGuide(diff, { base: 'main' }))).kind).toBe('invalid');
    useRunner(() => ok({ sections: [] }));
    expect((await failure(writeGuide(diff, { base: 'main' }))).kind).toBe('invalid');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    useRunner(() => ok({ groups: [{ title: 'T', summary: 'S', blocks: ['nope'] }] }));
    expect((await failure(writeGuide(diff, { base: 'main' }))).kind).toBe('invalid');
  });

  it('no output and a non-zero exit', async () => {
    useRunner(() => ({ code: 2, stdout: '', stderr: 'boom', timedOut: false }));
    const e = await failure(writeGuide(diff, { base: 'main' }));
    expect(e.kind).toBe('failed');
    expect(e.message).toMatch(/boom/);
  });

  it('a runner that cannot start', async () => {
    prev = setOneshotRunner(async () => {
      throw new Error('spawn failed');
    });
    expect((await failure(writeGuide(diff, { base: 'main' }))).kind).toBe('failed');
  });
});

describe('writeGuide over budget', () => {
  it('two passes: a line per block in batches, then one call to group them', async () => {
    // Big blocks (18 edited lines each), so one fits a call and four do not.
    const span = Array.from({ length: 18 }, (_, i) => i + 3);
    const diff = buildBranchDiff(['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((p) => edited(p, span)), statReason);
    const biggest = Math.max(...diff.order.map((id) => estimateTokens(renderBlock(diff.blocks.get(id)!, diff)) + 1));
    expect(4 * biggest).toBeGreaterThan(biggest + 300);
    const progress: string[] = [];
    const calls = useRunner((req) => {
      const ids = [...req.prompt.matchAll(/\[([a-z0-9]+)\]/g)].map((m) => m[1]!);
      if (JSON.parse(req.jsonSchema).required[0] === 'blocks') {
        // Ids as a model sometimes writes them, bracketed: still matched.
        return ok({ blocks: ids.map((id) => ({ id: `[${id}]`, line: `changes ${id}` })) });
      }
      return ok({ groups: [{ title: 'All', summary: 'S', blocks: ids }] });
    });
    // Room for one block per call, and for four summary lines.
    const guide = await writeGuide(diff, {
      base: 'main',
      budget: CALL_OVERHEAD_TOKENS + Math.max(biggest, 4 * SUMMARY_LINE_TOKENS) + 20,
      onProgress: (p) => progress.push(`${p.step}/${p.of}`),
    });
    const pass1 = calls.filter((c) => JSON.parse(c.jsonSchema).required[0] === 'blocks');
    expect(pass1.length).toBeGreaterThan(1);
    expect(calls).toHaveLength(pass1.length + 1);
    // Pass two reads the lines, not the code.
    expect(calls.at(-1)!.prompt).toContain(`[${diff.order[0]}] a.ts +18 -18: changes ${diff.order[0]}`);
    expect(calls.at(-1)!.prompt).not.toContain('+line 3 edited');
    expect(guide.groups[0]!.blocks).toEqual(diff.order);
    expect(progress.at(-1)).toBe(`${pass1.length + 1}/${pass1.length + 1}`);
  });

  it('groups by folder with no call at all when even the lines do not fit, and says why', async () => {
    const diff = buildBranchDiff(
      Array.from({ length: 30 }, (_, i) => edited(`${i % 2 ? 'src' : 'docs'}/f${i}.ts`, [3])),
      statReason,
    );
    const calls = useRunner(() => ok({}));
    const guide = await writeGuide(diff, { base: 'main', budget: CALL_OVERHEAD_TOKENS + 100 });
    expect(calls).toHaveLength(0);
    expect(guide.fallback).toMatch(/too many to group.*Grouped by folder/);
    expect(guide.groups.map((g) => g.title)).toEqual(['docs', 'src']);
    expect(guide.groups.flatMap((g) => g.blocks).sort()).toEqual([...diff.order].sort());
  });

  it('refuses an empty branch rather than writing an empty guide', async () => {
    const calls = useRunner(() => ok({}));
    const e = await failure(writeGuide(buildBranchDiff([], statReason), { base: 'main' }));
    expect(e.kind).toBe('invalid');
    expect(calls).toHaveLength(0);
  });
});
