import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { derivePending, HOOK_SCRIPT, hookSettingsArg, parseHookLines, type HookEvent } from './hookEvents';

const ev = (event: string, extra: Partial<HookEvent> = {}, at = 1): HookEvent =>
  ({
    event,
    toolName: null,
    toolUseId: null,
    toolInput: null,
    message: null,
    notificationType: null,
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

  it('a permission prompt (no tool_use_id) is cleared by the next PostToolUse', () => {
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
      ['Notification', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'Stop', 'UserPromptSubmit'].sort(),
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
    const r = spawnSync('sh', [script, '42'], { input: payload, env: { ...process.env, HOME: home } });
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

  it('reduces a huge PostToolUse to its name and id', () => {
    const big = 'x'.repeat(200_000);
    const [e] = run(JSON.stringify({ hook_event_name: 'PostToolUse', tool_use_id: 'tu5', tool_response: big }));
    expect(e).toMatchObject({ event: 'PostToolUse', toolUseId: 'tu5', toolInput: null });
  });
});
