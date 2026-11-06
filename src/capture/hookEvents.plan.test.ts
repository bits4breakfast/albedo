/**
 * #272: Claude Code's own plan approval (ExitPlanMode) keeps its plan, and
 * nothing else gains a field; the decisions the card sends for it; and an
 * answer typed by the card itself keeps its lines.
 */
import { describe, expect, it } from 'vitest';
import {
  KEEP_PLANNING_MESSAGE,
  MAX_PLAN_CHARS,
  derivePending,
  parseHookLines,
  planDecision,
  questionDecision,
  typedAnswerDecision,
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

const PLAN = '# Plan\n\n- Add `tags` to setup_info\n- Two tests';

function exitPlan(input: Record<string, unknown>): PendingPrompt {
  const p = derivePending([ev('PermissionRequest', { toolName: 'ExitPlanMode', toolInput: input, requestId: '5-1700000000000' })]);
  if (p === null) throw new Error('fixture');
  return p;
}

describe('ExitPlanMode: the plan is kept (#272)', () => {
  it('keeps the plan, as written, from a real request line', () => {
    const line = JSON.stringify({
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: PLAN },
      permission_suggestions: [],
      albedo_at: 1700000000000,
      albedo_req: '5-1700000000000',
    });
    const p = derivePending(parseHookLines(`${line}\n`));
    expect(p).toMatchObject({ kind: 'permission', toolName: 'ExitPlanMode', plan: PLAN, requestId: '5-1700000000000' });
  });

  it('cuts a plan longer than the cap', () => {
    const p = exitPlan({ plan: 'x'.repeat(MAX_PLAN_CHARS + 10) });
    expect(p.kind === 'permission' && p.plan?.length).toBe(MAX_PLAN_CHARS);
  });

  it('no plan, or not a string: no field', () => {
    expect('plan' in exitPlan({})).toBe(false);
    expect('plan' in exitPlan({ plan: 42 })).toBe(false);
  });

  it('every other tool keeps no plan, even with a `plan` in its input', () => {
    const p = derivePending([ev('PermissionRequest', { toolName: 'Bash', toolInput: { command: 'ls', plan: 'not this' }, requestId: '5-1' })]);
    expect(p).toMatchObject({ kind: 'permission', summary: 'Bash: ls' });
    expect(p && 'plan' in p).toBe(false);
  });
});

describe('planDecision', () => {
  const p = exitPlan({ plan: PLAN });
  const decision = (d: ReturnType<typeof planDecision>) => d?.hookSpecificOutput.decision;

  it('Approve is a plain allow', () => {
    expect(decision(planDecision(p, 'approve'))).toEqual({ behavior: 'allow' });
  });

  it('Keep Planning alone denies and interrupts, as the terminal does', () => {
    expect(decision(planDecision(p, 'keep-planning'))).toEqual({ behavior: 'deny', message: KEEP_PLANNING_MESSAGE, interrupt: true });
    expect(decision(planDecision(p, 'keep-planning', '   '))).toMatchObject({ interrupt: true });
  });

  it('Keep Planning with comments carries them, and lets Claude go on', () => {
    expect(decision(planDecision(p, 'keep-planning', 'Keep Planning. Comments on the plan:\n\n1. On "x":\n   y'))).toEqual({
      behavior: 'deny',
      message: 'Keep Planning. Comments on the plan:\n\n1. On "x":\n   y',
      interrupt: false,
    });
  });

  it('answers nothing but ExitPlanMode', () => {
    const bash = derivePending([ev('PermissionRequest', { toolName: 'Bash', toolInput: { command: 'ls' }, requestId: '5-1' })])!;
    expect(planDecision(bash, 'approve')).toBeNull();
  });
});

describe('typedAnswerDecision', () => {
  const ask = (questions: unknown[]) =>
    derivePending([ev('PermissionRequest', { toolName: 'AskUserQuestion', toolInput: { questions }, requestId: '5-1' })])!;
  const one = { question: 'Proceed?', header: 'Plan', multiSelect: false, options: [{ label: 'Approve' }, { label: 'Revise' }] };

  it('keeps the text’s lines, where the Other field makes one line of it', () => {
    const text = 'Revise. Comments on the plan (plan.md):\n\n1. On "a":\n   b';
    const d = typedAnswerDecision(ask([one]), text);
    expect(d?.hookSpecificOutput.decision).toEqual({
      behavior: 'allow',
      updatedInput: { questions: [one], answers: { 'Proceed?': text } },
    });
    // The Other field, for contrast: one line.
    const other = questionDecision(ask([one]), [{ labels: [], other: text }]);
    expect(other?.hookSpecificOutput.decision).toMatchObject({ updatedInput: { answers: { 'Proceed?': text.replace(/\s+/g, ' ') } } });
  });

  it('only for one question, and only with text', () => {
    expect(typedAnswerDecision(ask([one, { ...one, question: 'And?' }]), 'x')).toBeNull();
    expect(typedAnswerDecision(ask([one]), '  \n ')).toBeNull();
    expect(typedAnswerDecision(exitPlan({ plan: PLAN }), 'x')).toBeNull();
  });
});
