/**
 * Synthetic transcript lines in the shapes Claude Code 2.1.312 writes for
 * background work (measured, see adapter.ts), for tests only. Neutral text;
 * no real session's ids or descriptions.
 */

type Line = Record<string, unknown>;

const SESSION = 's1';

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** An assistant line with one tool call. */
export function callLine(id: string, name: string, input: Record<string, unknown>, ts: number, over: Line = {}): Line {
  return {
    type: 'assistant',
    sessionId: SESSION,
    isSidechain: false,
    timestamp: iso(ts),
    uuid: `a-${id}`,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    ...over,
  };
}

/** The user line with a call's result, and Claude Code's `toolUseResult`. */
export function resultLine(id: string, toolUseResult: Record<string, unknown>, ts: number, over: { isError?: boolean; text?: string } = {}): Line {
  return {
    type: 'user',
    sessionId: SESSION,
    isSidechain: false,
    timestamp: iso(ts),
    uuid: `r-${id}`,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: over.text ?? 'ok', is_error: over.isError === true }],
    },
    toolUseResult,
  };
}

/** A `<task-notification>` envelope. Omit `status` for a monitor's event. */
export function notification(o: { taskIds?: string[]; toolUseId?: string; status?: string; summary?: string; event?: string }): string {
  const parts = ['<task-notification>'];
  for (const t of o.taskIds ?? []) parts.push(`<task-id>${t}</task-id>`);
  if (o.toolUseId) parts.push(`<tool-use-id>${o.toolUseId}</tool-use-id>`);
  if (o.toolUseId) parts.push('<output-file>/tmp/out</output-file>');
  if (o.status) parts.push(`<status>${o.status}</status>`);
  parts.push(`<summary>${o.summary ?? 'Background command "Poll CI until green" completed (exit code 0)'}</summary>`);
  if (o.event) parts.push(`<event>${o.event}</event>`);
  parts.push('</task-notification>');
  return parts.join('\n');
}

/** A notification as a `user` line: the session was idle when it came. */
export function noticeUserLine(text: string, ts: number): Line {
  return { type: 'user', sessionId: SESSION, isSidechain: false, timestamp: iso(ts), uuid: `n-${ts}`, message: { role: 'user', content: text } };
}

/** A notification delivered into a running turn: an attachment, no user line. */
export function noticeAttachmentLine(text: string, ts: number, over: Line = {}): Line {
  return {
    type: 'attachment',
    sessionId: SESSION,
    isSidechain: false,
    timestamp: iso(ts),
    uuid: `q-${ts}`,
    attachment: {
      type: 'queued_command',
      prompt: text,
      commandMode: 'task-notification',
      origin: { kind: 'task-notification', producer: 'session-task' },
      source_uuid: 'x',
      timestamp: iso(ts),
    },
    ...over,
  };
}

// --- the starts, call and result -----------------------------------------

export function backgroundShell(id: string, taskId: string, ts: number, description = 'Poll CI until green'): Line[] {
  return [
    callLine(id, 'Bash', { command: 'until gh pr checks; do sleep 30; done', description, run_in_background: true }, ts),
    resultLine(id, { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: taskId }, ts + 50, {
      text: `Command running in background with ID: ${taskId}. Output is being written to: /tmp/${taskId}.output`,
    }),
  ];
}

export function asyncAgent(id: string, agentId: string, ts: number, description = 'Review the diff for regressions'): Line[] {
  return [
    callLine(id, 'Agent', { description, prompt: 'Review it', subagent_type: 'general-purpose' }, ts),
    resultLine(id, { isAsync: true, status: 'async_launched', agentId, description, prompt: 'Review it', outputFile: '/tmp/a' }, ts + 50, {
      text: `Async agent launched successfully. agentId: ${agentId}`,
    }),
  ];
}

export function monitor(id: string, taskId: string, ts: number, timeoutMs = 30 * 60_000): Line[] {
  return [
    callLine(id, 'Monitor', { command: 'tail -f build.log', description: 'Watch the build log', timeout_ms: timeoutMs }, ts),
    resultLine(id, { taskId, timeoutMs, persistent: false }, ts + 50, { text: `Monitor started (task ${taskId}, expires in 30m).` }),
  ];
}

export function wakeup(id: string, ts: number, delaySeconds: number, reason = 'Timer: wait 5 minutes before the next check'): Line[] {
  return [
    callLine(id, 'ScheduleWakeup', { delaySeconds, reason, prompt: '<<autonomous-loop-dynamic>>', noop: true }, ts),
    resultLine(id, { scheduledFor: ts + delaySeconds * 1000, clampedDelaySeconds: delaySeconds, wasClamped: false }, ts + 50, {
      text: 'Next wakeup scheduled.',
    }),
  ];
}

export function stopWakeups(id: string, ts: number): Line[] {
  return [
    callLine(id, 'ScheduleWakeup', { stop: true }, ts),
    resultLine(id, { scheduledFor: 0, clampedDelaySeconds: 0, wasClamped: false, stopped: true, cancelledWakeups: 1 }, ts + 50),
  ];
}

export function taskStop(id: string, taskId: string, ts: number): Line[] {
  return [
    callLine(id, 'TaskStop', { task_id: taskId }, ts),
    resultLine(id, { message: `Successfully stopped task: ${taskId}`, task_id: taskId, task_type: 'local_bash', command: 'sleep 300' }, ts + 50),
  ];
}

// --- a subagent's runs (#139), as 2.1.314 writes them ----------------------

/**
 * The notification that an async agent stopped. `waiting` is the shape for
 * one that stopped with background work of its own still running.
 */
export function agentNotification(o: {
  agentId: string;
  toolUseId?: string;
  status?: string;
  description?: string;
  waiting?: boolean;
}): string {
  const d = o.description ?? 'Review the diff for regressions';
  const parts = ['<task-notification>', `<task-id>${o.agentId}</task-id>`];
  if (o.toolUseId) parts.push(`<tool-use-id>${o.toolUseId}</tool-use-id>`);
  parts.push(`<output-file>/tmp/${o.agentId}.output</output-file>`);
  parts.push(`<status>${o.status ?? 'completed'}</status>`);
  if (o.waiting) {
    parts.push(`<summary>Agent "${d}" is waiting on its own background work</summary>`);
    parts.push(
      '<note>This agent stopped with background work of its own still running. It may resume on its own when that work completes or reports, and the same task-id notifies again if it does; the result below may be interim.</note>',
    );
  } else {
    parts.push(`<summary>Agent "${d}" completed</summary>`);
  }
  parts.push('<result>Looked at the diff; nothing to report yet.</result>');
  parts.push('<usage><subagent_tokens>1200</subagent_tokens><tool_uses>3</tool_uses><duration_ms>42000</duration_ms></usage>');
  parts.push('</task-notification>');
  return parts.join('\n');
}

/** A notification as the `user` line 2.1.314 writes when the session is idle. */
export function systemNoticeUserLine(text: string, ts: number): Line {
  return {
    ...noticeUserLine(text, ts),
    origin: { kind: 'task-notification', producer: 'session-task', runId: 'run-1' },
    promptSource: 'system',
    queueSkipAttachments: true,
  };
}

/** `SendMessage` to an agent that had stopped, and the result that resumed it. */
export function sendMessageResume(id: string, agentId: string, ts: number): Line[] {
  return [
    callLine(id, 'SendMessage', { to: agentId, message: 'Carry on with the second half' }, ts),
    resultLine(
      id,
      { success: true, message: `Resuming agent ${agentId.slice(0, 7)}`, resumedAgentId: agentId, revivedAgentId: agentId },
      ts + 50,
      { text: JSON.stringify({ success: true, message: `Resuming agent ${agentId.slice(0, 7)}`, resumedAgentId: agentId }) },
    ),
  ];
}
