/**
 * The writer, with an injected runner: no real `claude` ever runs here. The
 * outputs below are shaped as measured on Claude Code 2.1.316 (writer.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBranchDiff, type BranchDiff } from './blocks';
import { estimateTokens, renderBlock, statReason, SUMMARY_LINE_TOKENS } from './budget';
import { changed, edited, lines, text } from './fixtures';
import { NOTE_MAX_CHARS } from './validate';
import {
  CALL_OVERHEAD_TOKENS,
  findResult,
  GuideError,
  NOTES_SYSTEM,
  setOneshotRunner,
  writeGuide,
  writeNotes,
  type OneshotOutput,
  type OneshotRequest,
} from './writer';

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

describe('notes come after the groups (#224)', () => {
  // a.ts and c.ts change 3 lines each (+3 -3); b.ts one (+1 -1); the lockfile is a stat line.
  const diff = buildBranchDiff(
    [
      edited('src/a.ts', [3, 4, 5]),
      edited('src/b.ts', [5]),
      edited('src/c.ts', [10, 11, 12]),
      changed('package-lock.json', text(lines(40)), text(lines(40).map((l, i) => (i < 5 ? `${l} x` : l)))),
    ],
    statReason,
  );
  const idOf = (path: string) => diff.files.find((f) => f.path === path)!.blocks[0]!;
  const [a, b, c, lock] = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'package-lock.json'].map(idOf) as [string, string, string, string];

  it('the grouping call asks for no notes, and keeps none even if some come back', async () => {
    const calls = useRunner(() =>
      ok({ groups: [{ title: 'Paging', summary: 'S', blocks: [a, b, c, lock], notes: [{ path: 'src/a.ts', note: 'n' }] }] }),
    );
    const guide = await writeGuide(diff, { base: 'main' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).not.toContain('Files to note');
    expect(calls[0]!.systemPrompt).not.toMatch(/note/i);
    const schema = JSON.parse(calls[0]!.jsonSchema);
    expect(Object.keys(schema.properties.groups.items.properties)).not.toContain('notes');
    expect(guide.groups[0]!.notes).toBeUndefined();
  });

  it('pass two asks for no notes either', async () => {
    const span = Array.from({ length: 18 }, (_, i) => i + 3);
    const two = buildBranchDiff([edited('src/a.ts', span), edited('src/c.ts', span)], statReason);
    const total = two.order.reduce((n, id) => n + estimateTokens(renderBlock(two.blocks.get(id)!, two)) + 1, 0);
    const calls = useRunner((req) => {
      const ids = [...req.prompt.matchAll(/\[([a-z0-9]+)\]/g)].map((m) => m[1]!);
      if (JSON.parse(req.jsonSchema).required[0] === 'blocks') return ok({ blocks: ids.map((id) => ({ id, line: `changes ${id}` })) });
      return ok({ groups: [{ title: 'All', summary: 'S', blocks: ids }] });
    });
    await writeGuide(two, { base: 'main', budget: CALL_OVERHEAD_TOKENS + total - 1 });
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((x) => !x.prompt.includes('Files to note'))).toBe(true);
  });

  it('a group’s notes call has its title, summary, the files to note, and its blocks in full', async () => {
    const calls = useRunner(() =>
      ok({
        notes: [
          { path: 'src/a.ts', note: '  keeps the page size\n in one place ' },
          { path: 'src/c.ts', note: 'x'.repeat(NOTE_MAX_CHARS + 30) },
          { path: 'src/b.ts', note: 'not listed: too small' },
          { path: 'src/elsewhere.ts', note: 'dropped' },
          { bad: true },
        ],
      }),
    );
    const notes = await writeNotes(diff, { title: 'Paging', summary: 'Pages the list.', blocks: [a, b, c, lock] });
    expect(calls).toHaveLength(1);
    const p = calls[0]!.prompt;
    expect(p).toContain('Group: Paging\nSummary: Pages the list.\nFiles to note:\n- src/a.ts\n- src/c.ts\n');
    // The lines themselves, not a summary of them.
    expect(p).toContain(renderBlock(diff.blocks.get(a)!, diff));
    expect(p).toContain(renderBlock(diff.blocks.get(c)!, diff));
    expect(calls[0]!.systemPrompt).toBe(NOTES_SYSTEM);
    expect(JSON.parse(calls[0]!.jsonSchema).required).toEqual(['notes']);
    expect(notes).toEqual({ 'src/a.ts': 'keeps the page size in one place', 'src/c.ts': `${'x'.repeat(NOTE_MAX_CHARS - 1)}…` });
  });

  it('the notes prompt asks why, not what', () => {
    expect(NOTES_SYSTEM).toMatch(/WHY this file changes/);
    expect(NOTES_SYSTEM).toMatch(/Do not restate what changed/);
    expect(NOTE_MAX_CHARS).toBeGreaterThanOrEqual(200);
  });

  it('makes no call for a group with nothing to note: one file, or only small or stat-only files', async () => {
    const calls = useRunner(() => ok({ notes: [] }));
    expect(await writeNotes(diff, { title: 'One file', summary: '', blocks: [a] })).toBeNull();
    expect(await writeNotes(diff, { title: 'Small', summary: '', blocks: [b, lock] })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('skips a group too large for one call, without a call', async () => {
    const calls = useRunner(() => ok({ notes: [] }));
    expect(await writeNotes(diff, { title: 'Paging', summary: '', blocks: [a, c] }, { budget: 50 })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('a reply in the wrong shape is an error', async () => {
    useRunner(() => ok({ groups: [] }));
    const e = await failure(writeNotes(diff, { title: 'Paging', summary: '', blocks: [a, c] }));
    expect(e.kind).toBe('invalid');
  });
});
