import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  alwaysAllowRules,
  applyHookEvents,
  completeLines,
  currentPrompt,
  emptyPending,
  isQuiet,
  MAX_LINE_CHARS,
  ANSWER_WINDOW_S,
  answerFileName,
  answerText,
  DENY_MESSAGE,
  derivePending,
  latestSessionStart,
  HOOK_SCRIPT,
  hookSettingsArg,
  isAnswerable,
  parseHookLines,
  parseStatusSnapshot,
  permissionDecision,
  questionDecision,
  type HookEvent,
  type PendingPrompt,
} from './hookEvents';

const ev = (event: string, extra: Partial<HookEvent> = {}, at = 1): HookEvent =>
  ({
    event,
    toolName: null,
    toolUseId: null,
    toolInput: null,
    message: null,
    notificationType: null,
    requestId: null,
    suggestions: null,
    sessionId: null,
    source: null,
    at,
    ...extra,
  }) as HookEvent;

describe('derivePending', () => {
  it('raises a question from PreToolUse of AskUserQuestion, with its options', () => {
    const p = derivePending([
      ev('PreToolUse', {
        toolName: 'AskUserQuestion',
        toolUseId: 'tu1',
        toolInput: {
          questions: [
            { question: 'Approve the plan?', header: 'Plan', multiSelect: false, options: [{ label: 'Approve', description: 'Go' }, { label: 'Revise' }] },
          ],
        },
      }),
    ]);
    expect(p?.kind).toBe('question');
    if (p?.kind === 'question') {
      expect(p.questions[0]?.question).toBe('Approve the plan?');
      expect(p.questions[0]?.options.map((o) => o.label)).toEqual(['Approve', 'Revise']);
    }
  });

  it('raises a permission prompt and summarises the command', () => {
    const p = derivePending([ev('PermissionRequest', { toolName: 'Bash', toolInput: { command: 'rm -rf build' } })]);
    expect(p).toMatchObject({ kind: 'permission', toolName: 'Bash', summary: 'Bash: rm -rf build' });
  });

  it('clears when the tool finishes, the turn stops, or the user prompts again', () => {
    const ask = ev('PreToolUse', { toolName: 'AskUserQuestion', toolUseId: 'a', toolInput: { questions: [] } });
    expect(derivePending([ask, ev('PostToolUse', { toolUseId: 'a' })])).toBeNull();
    expect(derivePending([ask, ev('Stop')])).toBeNull();
    expect(derivePending([ask, ev('UserPromptSubmit')])).toBeNull();
  });

  it('a permission line with no request id (no waiting hook) is still cleared by the next PostToolUse', () => {
    const perm = ev('PermissionRequest', { toolName: 'Bash', toolInput: { command: 'ls' } });
    expect(derivePending([perm, ev('PostToolUse', { toolUseId: 'x' })])).toBeNull();
  });

  it('a different tool starting means the prompt was resolved (denied)', () => {
    const perm = ev('PermissionRequest', { toolName: 'Bash', toolInput: { command: 'ls' } });
    expect(derivePending([perm, ev('PreToolUse', { toolName: 'Read', toolUseId: 'r' })])).toBeNull();
  });

  it('ignores idle Notifications and unknown events', () => {
    expect(derivePending([ev('Notification', { notificationType: 'idle_prompt' })])).toBeNull();
    const perm = ev('PermissionRequest', { toolName: 'Bash' });
    expect(derivePending([perm, ev('Notification'), ev('SomethingNew')])).toMatchObject({ kind: 'permission' });
  });

  it('a permission_prompt Notification is a fallback notice, never overriding detail', () => {
    const note = ev('Notification', { notificationType: 'permission_prompt', message: 'Claude needs your permission' });
    expect(derivePending([note])).toMatchObject({ kind: 'notice', message: 'Claude needs your permission' });
    const perm = ev('PermissionRequest', { toolName: 'Bash' });
    expect(derivePending([perm, note])).toMatchObject({ kind: 'permission' });
    expect(derivePending([note, ev('Stop')])).toBeNull();
  });
});

describe('parseHookLines', () => {
  it('skips blank, torn and foreign lines', () => {
    const out = parseHookLines('\n{not json\n{"hello":1}\n{"hook_event_name":"Stop","albedo_at":5}\n');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ event: 'Stop', at: 5 });
  });
});

describe('hookSettingsArg', () => {
  it('is valid JSON naming every hook, quoting the script path', () => {
    const j = JSON.parse(hookSettingsArg(7, '/Users/a b/.albedo/hook.sh'));
    expect(Object.keys(j.hooks).sort()).toEqual(
      [
        'Notification',
        'PermissionRequest',
        'PostToolUse',
        'PostToolUseFailure',
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Stop',
        'UserPromptSubmit',
      ].sort(),
    );
    expect(j.hooks.PreToolUse[0].matcher).toBe('AskUserQuestion');
    expect(j.hooks.Stop[0].hooks[0].command).toBe('sh "/Users/a b/.albedo/hook.sh" 7');
  });
});

describe('HOOK_SCRIPT, run for real', () => {
  function run(payload: string): HookEvent[] {
    const home = mkdtempSync(join(tmpdir(), 'albedo-hook-'));
    const script = join(home, 'hook.sh');
    writeFileSync(script, HOOK_SCRIPT);
    // Window of 1 s: a PermissionRequest waits for an answer, and none comes.
    const r = spawnSync('sh', [script, '42', '1'], { input: payload, env: { ...process.env, HOME: home } });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe('');
    return parseHookLines(readFileSync(join(home, '.albedo/events/task-42.jsonl'), 'utf8'));
  }

  it('keeps the detail of a permission request and stamps a time', () => {
    const [e] = run(
      JSON.stringify({ session_id: 's', cwd: '/w', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'echo "hi"' } }),
    );
    expect(e).toMatchObject({ event: 'PermissionRequest', toolName: 'Bash', toolInput: { command: 'echo "hi"' } });
    expect(e?.at).toBeGreaterThan(1_700_000_000_000);
  });

  it('survives a pretty-printed payload', () => {
    const [e] = run(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'tu9', tool_input: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] } }, null, 2));
    expect(e).toMatchObject({ event: 'PreToolUse', toolUseId: 'tu9' });
    expect(derivePending([e as HookEvent])?.kind).toBe('question');
  });

  it('keeps the session id and source of a SessionStart, and nothing else', () => {
    const sid = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    const [e] = run(
      JSON.stringify({ session_id: sid, transcript_path: '/p/x.jsonl', cwd: '/w', hook_event_name: 'SessionStart', source: 'clear' }),
    );
    expect(e).toMatchObject({ event: 'SessionStart', sessionId: sid, source: 'clear' });
  });

  it('drops a session id that is not a UUID', () => {
    const [e] = run(JSON.stringify({ session_id: '../../etc"x', hook_event_name: 'SessionStart', source: 'startup' }));
    expect(e).toMatchObject({ event: 'SessionStart', sessionId: null });
  });

  it('reduces a huge PostToolUse to its name and id', () => {
    const big = 'x'.repeat(200_000);
    const [e] = run(JSON.stringify({ hook_event_name: 'PostToolUse', tool_use_id: 'tu5', tool_response: big }));
    expect(e).toMatchObject({ event: 'PostToolUse', toolUseId: 'tu5', toolInput: null });
  });
});

// ---------------------------------------------------------------------------
// Answering from the card
// ---------------------------------------------------------------------------

const ASK_INPUT = {
  questions: [
    { question: 'Pick a colour', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }] },
    { question: 'Pick fruits', header: 'Fruit', multiSelect: true, options: [{ label: 'Apple' }, { label: 'Pear' }, { label: 'Plum' }], extra: 'kept' },
  ],
};

const SUGGEST = [
  { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'curl -s https://example.com' }], behavior: 'allow', destination: 'localSettings' },
];

describe('derivePending with a waiting hook', () => {
  it('AskUserQuestion: the PermissionRequest adds its request id to the question, keeping the tool_use_id', () => {
    const pre = ev('PreToolUse', { toolName: 'AskUserQuestion', toolUseId: 'tu1', toolInput: ASK_INPUT }, 1);
    const req = ev('PermissionRequest', { toolName: 'AskUserQuestion', toolInput: ASK_INPUT, requestId: '12-1700000000000' }, 2);
    const p = derivePending([pre, req]);
    expect(p).toMatchObject({ kind: 'question', toolUseId: 'tu1', requestId: '12-1700000000000', at: 2 });
    // Before this, the permission branch turned the question into "Needs permission: AskUserQuestion".
    expect(derivePending([pre, req, ev('PostToolUse', { toolUseId: 'tu1' })])).toBeNull();
  });

  it('AskUserQuestion PermissionRequest alone still raises a question', () => {
    const p = derivePending([ev('PermissionRequest', { toolName: 'AskUserQuestion', toolInput: ASK_INPUT, requestId: '1-1700000000000' })]);
    expect(p).toMatchObject({ kind: 'question', toolUseId: null, requestId: '1-1700000000000' });
    if (p?.kind === 'question') expect(p.rawQuestions).toBe(ASK_INPUT.questions);
  });

  it('a permission prompt carries its request id and the rules "don\'t ask again" would add', () => {
    const p = derivePending([
      ev('PermissionRequest', { toolName: 'Bash', toolInput: { command: 'curl -s https://example.com' }, requestId: '5-1700000000000', suggestions: SUGGEST }),
    ]);
    expect(p).toMatchObject({ kind: 'permission', requestId: '5-1700000000000' });
    if (p?.kind === 'permission') expect(p.alwaysAllow?.map((r) => r.label)).toEqual(['Bash(curl -s https://example.com)']);
  });
});

describe('parseHookLines: albedo_req', () => {
  it('keeps a well-formed request id and drops anything that could escape a file name', () => {
    const line = (req: string) => JSON.stringify({ hook_event_name: 'PermissionRequest', albedo_req: req, albedo_at: 1 });
    expect(parseHookLines(line('4242-1792271916000'))[0]?.requestId).toBe('4242-1792271916000');
    expect(parseHookLines(line('../../etc'))[0]?.requestId).toBeNull();
    expect(parseHookLines(line('1-2'))[0]?.requestId).toBeNull();
  });
});

describe('alwaysAllowRules', () => {
  it('offers plain allow rules, labelled as settings files spell them', () => {
    const r = alwaysAllowRules([
      { type: 'addRules', rules: [{ toolName: 'WebFetch' }, { toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'session' },
    ]);
    expect(r?.map((x) => [x.label, x.destination])).toEqual([['WebFetch, Bash(ls)', 'session']]);
  });

  it('offers nothing when any suggestion is wider than a rule list', () => {
    expect(alwaysAllowRules(null)).toBeNull();
    expect(alwaysAllowRules([])).toBeNull();
    expect(alwaysAllowRules([...SUGGEST, { type: 'setMode', mode: 'acceptEdits', destination: 'session' }])).toBeNull();
    expect(alwaysAllowRules([{ ...SUGGEST[0], behavior: 'deny' }])).toBeNull();
    expect(alwaysAllowRules([{ ...SUGGEST[0], rules: [] }])).toBeNull();
    expect(alwaysAllowRules([{ ...SUGGEST[0], destination: undefined }])).toBeNull();
    expect(alwaysAllowRules([{ type: 'addDirectories', directories: ['/'], destination: 'session' }])).toBeNull();
  });
});

const perm = (extra: Partial<Extract<PendingPrompt, { kind: 'permission' }>> = {}): PendingPrompt => ({
  kind: 'permission',
  toolUseId: null,
  toolName: 'Bash',
  summary: 'Bash: ls',
  requestId: '9-1700000000000',
  alwaysAllow: null,
  at: 1_000,
  ...extra,
});

const question = (extra: Partial<Extract<PendingPrompt, { kind: 'question' }>> = {}): PendingPrompt => {
  const p = derivePending([ev('PermissionRequest', { toolName: 'AskUserQuestion', toolInput: ASK_INPUT, requestId: '9-1700000000000' }, 1_000)]);
  if (p?.kind !== 'question') throw new Error('fixture');
  return { ...p, ...extra };
};

describe('permissionDecision', () => {
  it('allow carries no updatedInput: the tool runs with exactly what was shown', () => {
    expect(permissionDecision(perm(), 'allow')).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });

  it('deny interrupts, like the terminal "No"', () => {
    expect(permissionDecision(perm(), 'deny')?.hookSpecificOutput.decision).toEqual({
      behavior: 'deny',
      message: DENY_MESSAGE,
      interrupt: true,
    });
  });

  it('allow-always echoes the suggestion verbatim, and only when one was offered', () => {
    expect(permissionDecision(perm(), 'allow-always')).toBeNull();
    const rules = alwaysAllowRules(SUGGEST);
    expect(permissionDecision(perm({ alwaysAllow: rules }), 'allow-always')?.hookSpecificOutput.decision).toEqual({
      behavior: 'allow',
      updatedPermissions: SUGGEST,
    });
  });

  it('is never a decision for a question', () => {
    expect(permissionDecision(question(), 'allow')).toBeNull();
  });
});

describe('answerText', () => {
  const single = { header: null, question: 'Q', multiSelect: false, options: [{ label: 'A', description: null }, { label: 'B', description: null }] };
  const multi = { ...single, multiSelect: true };

  it('single-select: one label, or the typed text in its place', () => {
    expect(answerText(single, { labels: ['B'], other: '' })).toBe('B');
    expect(answerText(single, { labels: ['B', 'A'], other: '' })).toBe('A'); // option order; one only
    expect(answerText(single, { labels: ['A'], other: '  my   own  ' })).toBe('my own');
  });

  it('multi-select: labels in option order, then any typed text, joined as Claude Code shows them', () => {
    expect(answerText(multi, { labels: ['B', 'A'], other: '' })).toBe('A, B');
    expect(answerText(multi, { labels: ['B'], other: 'C' })).toBe('B, C');
  });

  it('nothing chosen, or only labels the question does not offer, is no answer', () => {
    expect(answerText(single, undefined)).toBeNull();
    expect(answerText(single, { labels: [], other: '   ' })).toBeNull();
    expect(answerText(multi, { labels: ['Z'], other: '' })).toBeNull();
  });
});

describe('questionDecision', () => {
  it('echoes the questions verbatim and maps each question to its answer', () => {
    const d = questionDecision(question(), [
      { labels: ['Green'], other: '' },
      { labels: ['Plum', 'Apple'], other: '' },
    ]);
    expect(d).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedInput: { questions: ASK_INPUT.questions, answers: { 'Pick a colour': 'Green', 'Pick fruits': 'Apple, Plum' } },
        },
      },
    });
  });

  it('is null until every question is answered', () => {
    expect(questionDecision(question(), [{ labels: ['Green'], other: '' }])).toBeNull();
    expect(questionDecision(question(), [{ labels: ['Green'], other: '' }, { labels: [], other: '' }])).toBeNull();
  });

  it('is null when a question could not be parsed, or for a permission prompt', () => {
    const q = question();
    if (q.kind !== 'question') throw new Error('fixture');
    const short = { ...q, rawQuestions: [...q.rawQuestions, { nope: true }] };
    expect(questionDecision(short, [{ labels: ['Red'], other: '' }, { labels: ['Pear'], other: '' }])).toBeNull();
    expect(questionDecision(perm(), [])).toBeNull();
  });
});

describe('isAnswerable', () => {
  const now = 2_000;
  it('only the very prompt the card showed, with a hook still waiting', () => {
    const shown = perm();
    expect(isAnswerable(shown, shown, now)).toBe(true);
    expect(isAnswerable({ ...shown }, shown, now)).toBe(true);
  });

  it('refuses when the prompt cleared or was replaced, even by an identical-looking one', () => {
    const shown = perm();
    expect(isAnswerable(null, shown, now)).toBe(false);
    expect(isAnswerable(perm({ requestId: '10-1700000000000' }), shown, now)).toBe(false);
    expect(isAnswerable(question(), shown, now)).toBe(false);
  });

  it('refuses with no hook waiting, for a notice, and once the window has closed', () => {
    const noHook = perm({ requestId: null });
    expect(isAnswerable(noHook, noHook, now)).toBe(false);
    const notice: PendingPrompt = { kind: 'notice', toolUseId: null, message: 'm', at: 1 };
    expect(isAnswerable(notice, notice, now)).toBe(false);
    const shown = perm();
    expect(isAnswerable(shown, shown, shown.at + ANSWER_WINDOW_S * 1000)).toBe(false);
    expect(isAnswerable(shown, shown, shown.at + (ANSWER_WINDOW_S - 20) * 1000)).toBe(true);
  });
});

describe('derivePending: answers already taken', () => {
  it('skips a request whose answer the hook took, and shows the next one', () => {
    const a = ev('PermissionRequest', { toolName: 'Bash', toolInput: { command: 'a' }, requestId: '9-1700000000000' }, 1);
    const b = ev('PermissionRequest', { toolName: 'Bash', toolInput: { command: 'b' }, requestId: '10-1700000000000' }, 2);
    expect(derivePending([a], new Set(['9-1700000000000']))).toBeNull();
    expect(derivePending([a, b], new Set(['9-1700000000000']))).toMatchObject({ requestId: '10-1700000000000' });
    expect(derivePending([a, b], new Set(['other']))).toMatchObject({ requestId: '9-1700000000000' });
  });
});

describe('hookSettingsArg: the answer window', () => {
  it('gives PermissionRequest a timeout past the script window, so the script quits first', () => {
    const j = JSON.parse(hookSettingsArg(7, '/x/hook.sh'));
    expect(j.hooks.PermissionRequest[0].hooks[0].timeout).toBeGreaterThan(ANSWER_WINDOW_S);
    expect(j.hooks.PermissionRequest[0].hooks[0].command).toBe('sh "/x/hook.sh" 7');
    expect(j.hooks.Stop[0].hooks[0].timeout).toBeUndefined();
  });
});

describe('HOOK_SCRIPT waiting for an answer, run for real', () => {
  const PAYLOAD = JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });

  /** Run a PermissionRequest; `answer` is called once its line is written. */
  async function wait(answer: (dir: string, req: string) => void, windowS = 3): Promise<{ stdout: string; dir: string; ms: number }> {
    const home = mkdtempSync(join(tmpdir(), 'albedo-hook-'));
    const script = join(home, 'hook.sh');
    writeFileSync(script, HOOK_SCRIPT);
    const dir = join(home, '.albedo/events');
    const started = Date.now();
    const child = spawn('sh', [script, '42', String(windowS)], { env: { ...process.env, HOME: home } });
    let stdout = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
    child.stdin.end(PAYLOAD);
    const poll = setInterval(() => {
      const f = join(dir, 'task-42.jsonl');
      if (!existsSync(f)) return;
      const req = parseHookLines(readFileSync(f, 'utf8'))[0]?.requestId;
      if (!req) return;
      clearInterval(poll);
      answer(dir, req);
    }, 50);
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    clearInterval(poll);
    expect(code).toBe(0);
    return { stdout, dir, ms: Date.now() - started };
  }

  it('stamps a request id, then prints its own answer file verbatim and removes it', async () => {
    const decision = JSON.stringify(permissionDecision(perm(), 'deny'));
    const { stdout, dir } = await wait((d, req) => writeFileSync(join(d, answerFileName(42, req)), decision));
    expect(stdout).toBe(decision);
    expect(readdirSync(dir).filter((f) => f.startsWith('answer-'))).toEqual([]);
  });

  it('never prints an answer meant for another request, and decides nothing when the window closes', async () => {
    const { stdout, ms } = await wait(
      (d) => writeFileSync(join(d, answerFileName(42, '1-1700000000000')), '{"allow":"wrong request"}'),
      1,
    );
    expect(stdout).toBe('');
    expect(ms).toBeGreaterThanOrEqual(900);
  });
});

// ---------------------------------------------------------------------------
// Request lifetime: end markers, concurrency, session end
// ---------------------------------------------------------------------------

const req = (id: string, command: string, at = 1) =>
  ev('PermissionRequest', { toolName: 'Bash', toolInput: { command }, requestId: id }, at);
const end = (id: string) => ev('AlbedoReqEnd', { requestId: id });

describe('derivePending: a waiting request ends only by its own end marker', () => {
  it('retires the request named by the marker, however the hook ended', () => {
    // Terminal "No" or Esc: no PostToolUse, no Stop -- only the marker.
    expect(derivePending([req('1-1700000000000', 'ls'), end('1-1700000000000')])).toBeNull();
    expect(derivePending([req('1-1700000000000', 'ls'), end('2-1700000000000')])).toMatchObject({ requestId: '1-1700000000000' });
  });

  it('an unrelated PostToolUse (a parallel subagent) does not clear it', () => {
    const p = derivePending([req('1-1700000000000', 'ls'), ev('PostToolUse', { toolUseId: 'sub-read' }), ev('PostToolUseFailure')]);
    expect(p).toMatchObject({ kind: 'permission', requestId: '1-1700000000000' });
  });

  it('a question that adopted its tool_use_id still clears on that PostToolUse, or on its marker', () => {
    const pre = ev('PreToolUse', { toolName: 'AskUserQuestion', toolUseId: 'tu1', toolInput: ASK_INPUT }, 1);
    const q = ev('PermissionRequest', { toolName: 'AskUserQuestion', toolInput: ASK_INPUT, requestId: '3-1700000000000' }, 2);
    expect(derivePending([pre, q, ev('PostToolUse', { toolUseId: 'other' })])).toMatchObject({ kind: 'question' });
    expect(derivePending([pre, q, ev('PostToolUse', { toolUseId: 'tu1' })])).toBeNull();
    expect(derivePending([pre, q, end('3-1700000000000')])).toBeNull();
  });

  it('several open at once: the oldest shows, and the task stays blocked until all end', () => {
    const evs = [req('1-1700000000000', 'a', 1), req('2-1700000000000', 'b', 2), req('3-1700000000000', 'c', 3)];
    expect(derivePending(evs)).toMatchObject({ summary: 'Bash: a' });
    expect(derivePending([...evs, end('1-1700000000000')])).toMatchObject({ summary: 'Bash: b' });
    expect(derivePending([...evs, end('2-1700000000000')])).toMatchObject({ summary: 'Bash: a' });
    expect(derivePending([...evs, end('1-1700000000000'), end('2-1700000000000')])).toMatchObject({ summary: 'Bash: c' });
    expect(derivePending([...evs, end('1-1700000000000'), end('2-1700000000000'), end('3-1700000000000')])).toBeNull();
  });

  it('SessionEnd, SessionStart, Stop and a new prompt clear every open request', () => {
    const evs = [req('1-1700000000000', 'a'), req('2-1700000000000', 'b')];
    for (const name of ['SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']) expect(derivePending([...evs, ev(name)])).toBeNull();
  });

  it('applies incrementally: the same events in two batches derive the same prompt', () => {
    const evs = [req('1-1700000000000', 'a', 1), req('2-1700000000000', 'b', 2), end('1-1700000000000')];
    const s = emptyPending();
    applyHookEvents(s, evs.slice(0, 2));
    expect(isQuiet(s)).toBe(false);
    applyHookEvents(s, evs.slice(2));
    expect(currentPrompt(s)).toEqual(derivePending(evs));
    applyHookEvents(s, [end('2-1700000000000')]);
    expect(isQuiet(s)).toBe(true);
  });
});

describe('completeLines', () => {
  it('holds back a trailing partial line, and cuts on bytes, not characters', () => {
    const enc = new TextEncoder();
    expect(completeLines(enc.encode('{"a":1}\n{"b":'))).toEqual({ text: '{"a":1}\n', consumed: 8 });
    expect(completeLines(enc.encode('{"b":'))).toEqual({ text: '', consumed: 0 });
    const multi = enc.encode('"é"\n');
    expect(completeLines(multi).consumed).toBe(multi.length);
  });
});

async function until<T>(get: () => T | null, ms = 5_000): Promise<T> {
  const stop = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== null) return v;
    if (Date.now() > stop) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 30));
  }
}

function setupScript(): { home: string; script: string; file: string } {
  const home = mkdtempSync(join(tmpdir(), 'albedo-hook-'));
  const script = join(home, 'hook.sh');
  writeFileSync(script, HOOK_SCRIPT);
  return { home, script, file: join(home, '.albedo/events/task-42.jsonl') };
}

const linesOf = (file: string) => (existsSync(file) ? parseHookLines(readFileSync(file, 'utf8')) : []);

describe('HOOK_SCRIPT: end markers, run for real', () => {
  const PAYLOAD = JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });

  it('writes the marker when the window closes unanswered', () => {
    const { home, script, file } = setupScript();
    spawnSync('sh', [script, '42', '1'], { input: PAYLOAD, env: { ...process.env, HOME: home } });
    const [r, e] = linesOf(file);
    expect(e).toMatchObject({ event: 'AlbedoReqEnd', requestId: r?.requestId });
    expect(derivePending(linesOf(file))).toBeNull();
  });

  it('writes the marker after printing a card answer', async () => {
    const { home, script, file } = setupScript();
    const child = spawn('sh', [script, '42', '5'], { env: { ...process.env, HOME: home } });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    const closed = new Promise((r) => child.on('close', r));
    child.stdin.end(PAYLOAD);
    const id = await until(() => linesOf(file)[0]?.requestId ?? null);
    writeFileSync(join(home, '.albedo/events', answerFileName(42, id)), '{"ok":1}');
    await closed;
    expect(out).toBe('{"ok":1}');
    expect(linesOf(file).map((e) => e.event)).toEqual(['PermissionRequest', 'AlbedoReqEnd']);
  });

  it('writes the marker promptly when SIGTERMed (the terminal answered), printing nothing', async () => {
    const { home, script, file } = setupScript();
    const child = spawn('sh', [script, '42', '30'], { env: { ...process.env, HOME: home } });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    const closed = new Promise((r) => child.on('close', r));
    child.stdin.end(PAYLOAD);
    const id = await until(() => linesOf(file)[0]?.requestId ?? null);
    const t = Date.now();
    child.kill('SIGTERM');
    await closed;
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(out).toBe('');
    expect(linesOf(file)[1]).toMatchObject({ event: 'AlbedoReqEnd', requestId: id });
    expect(derivePending(linesOf(file))).toBeNull();
  });
});

describe('HOOK_SCRIPT: safety, run for real', () => {
  const env = (home: string) => ({ ...process.env, HOME: home });

  it('ignores a non-numeric task id: nothing is written anywhere', () => {
    const { home, script } = setupScript();
    const r = spawnSync('sh', [script, '../x', '1'], { input: '{"hook_event_name":"Stop"}', env: env(home) });
    expect(r.status).toBe(0);
    expect(existsSync(join(home, '.albedo'))).toBe(false);
  });

  it('treats the payload as data: format specifiers and shell syntax are kept, never run', () => {
    const { home, script, file } = setupScript();
    const nasty = `%s %n $(touch ${join(home, 'pwned')}) \`touch ${join(home, 'pwned2')}\` \\" ' \${HOME}`;
    const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 't', tool_input: { x: nasty } });
    spawnSync('sh', [script, '42', '1'], { input: payload, env: env(home) });
    expect(linesOf(file)[0]?.toolInput).toEqual({ x: nasty });
    expect(existsSync(join(home, 'pwned')) || existsSync(join(home, 'pwned2'))).toBe(false);
  });

  it('reduces an oversized prompt payload to its name and tool, still one valid line', () => {
    const { home, script, file } = setupScript();
    const payload = JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { content: 'x'.repeat(MAX_LINE_CHARS + 10) } });
    spawnSync('sh', [script, '42', '0'], { input: payload, env: env(home) });
    const text = readFileSync(file, 'utf8');
    expect(text.length).toBeLessThan(1_000);
    expect(linesOf(file)[0]).toMatchObject({ event: 'PermissionRequest', toolName: 'Write', toolInput: null });
    expect(derivePending(linesOf(file).slice(0, 1))).toMatchObject({ kind: 'permission', summary: 'Write' });
  });

  it('concurrent hooks with large payloads never tear a line', async () => {
    const { home, script, file } = setupScript();
    const N = 16;
    await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const payload = JSON.stringify({ hook_event_name: 'Notification', notification_type: 'x', message: String(i % 10).repeat(60_000) });
        return new Promise<void>((resolve) => {
          const c = spawn('sh', [script, '42'], { env: env(home) });
          c.on('close', () => resolve());
          c.stdin.end(payload);
        });
      }),
    );
    const text = readFileSync(file, 'utf8');
    expect(text.split('\n').filter(Boolean)).toHaveLength(N);
    expect(parseHookLines(text)).toHaveLength(N);
  });
});

describe('latestSessionStart', () => {
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  it('takes the last SessionStart that names a session', () => {
    expect(
      latestSessionStart([
        ev('SessionStart', { sessionId: a, source: 'startup' }),
        ev('Stop'),
        ev('SessionStart', { sessionId: b, source: 'clear' }),
        ev('SessionStart', { sessionId: null, source: 'clear' }),
      ]),
    ).toEqual({ sessionId: b, source: 'clear' });
  });
  it('is null without one', () => {
    expect(latestSessionStart([ev('Stop'), ev('PostToolUse')])).toBeNull();
  });
});

describe('HOOK_SCRIPT: status-line mode, run for real', () => {
  // The shape Claude Code 2.1.304 hands a status-line command, trimmed.
  const SID = '3ce16cb4-9e4c-4e1a-ab05-2929f8391b74';
  const PAYLOAD = JSON.stringify({
    session_id: SID,
    cwd: '/w',
    model: { id: 'claude-opus-5-5', display_name: 'Opus' },
    cost: { total_cost_usd: 1.2 },
    context_window: {
      total_input_tokens: 5,
      context_window_size: 1_000_000,
      current_usage: { input_tokens: 3, cache_read_input_tokens: 2 },
      used_percentage: 42.5,
      remaining_percentage: 57.5,
    },
    rate_limits: {
      five_hour: { used_percentage: 29, resets_at: 1_792_500_000 },
      seven_day: { used_percentage: 14, resets_at: 1_792_900_000 },
    },
  });

  function status(payload: string) {
    const { home, script } = setupScript();
    const r = spawnSync('sh', [script, '42', 'status'], { input: payload, env: { ...process.env, HOME: home } });
    const path = join(home, '.albedo/events/status-42.json');
    return { r, home, text: existsSync(path) ? readFileSync(path, 'utf8') : null };
  }

  it('keeps the plan usage and the context fill, and prints nothing', () => {
    const { r, text } = status(PAYLOAD);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe('');
    expect(parseStatusSnapshot(text!)).toMatchObject({
      sessionId: SID,
      fiveHour: { usedPct: 29, resetsAt: 1_792_500_000_000 },
      sevenDay: { usedPct: 14, resetsAt: 1_792_900_000_000 },
      contextPct: 42.5,
      contextSize: 1_000_000,
    });
  });

  it('keeps nothing else from the payload', () => {
    const { text } = status(PAYLOAD);
    expect(Object.keys(JSON.parse(text!)).sort()).toEqual(
      ['albedo_at', 'ctx_pct', 'ctx_size', 'five_pct', 'five_resets', 'session_id', 'week_pct', 'week_resets'],
    );
    expect(text).not.toContain('claude-opus');
  });

  it('writes nulls, still valid JSON, for an API-key session before its first reply', () => {
    const { text } = status(
      JSON.stringify({ session_id: SID, context_window: { context_window_size: 200_000, current_usage: null, used_percentage: null, remaining_percentage: null } }),
    );
    expect(parseStatusSnapshot(text!)).toMatchObject({ fiveHour: null, sevenDay: null, contextPct: null, contextSize: 200_000 });
  });

  it('writes no event line and leaves no scratch file', () => {
    const { home } = status(PAYLOAD);
    expect(readdirSync(join(home, '.albedo/events'))).toEqual(['status-42.json']);
  });
});

describe('parseStatusSnapshot', () => {
  it('rejects a torn file and an untrusted session id', () => {
    expect(parseStatusSnapshot('{"five_pct":2')).toBeNull();
    expect(parseStatusSnapshot('{"session_id":"../x","albedo_at":1}')?.sessionId).toBeNull();
  });
});

describe('hookSettingsArg: status line', () => {
  it('runs the same script in status mode, with no padding', () => {
    const j = JSON.parse(hookSettingsArg(7, '/x/hook.sh'));
    expect(j.statusLine).toEqual({ type: 'command', command: 'sh "/x/hook.sh" 7 status', padding: 0 });
  });
});
