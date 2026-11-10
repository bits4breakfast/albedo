/**
 * A turn that stopped on an API error (#338): the adapter reads the error
 * line Claude Code writes, and `lastApiError` says whether the session's last
 * turn stopped on one. The lines are shaped like Claude Code 2.1.322's, with
 * made-up text around them.
 */

import { describe, expect, it } from 'vitest';

import { apiErrorOf, parseTranscript } from './adapter';
import { apiErrorTail, deriveStatus, lastApiError } from './status';
import type { Message } from '../types';

const SESSION = 'sess-err';
const T0 = Date.parse('2026-11-10T09:00:00.000Z');

let clock = 0;
const at = () => new Date(T0 + 1_000 * clock++).toISOString();

const prompt = (text: string) =>
  JSON.stringify({ type: 'user', sessionId: SESSION, timestamp: at(), message: { role: 'user', content: text } });

const reply = (text: string, stopReason = 'end_turn') =>
  JSON.stringify({
    type: 'assistant',
    sessionId: SESSION,
    timestamp: at(),
    message: { role: 'assistant', model: 'claude-x', stop_reason: stopReason, content: [{ type: 'text', text }] },
  });

const toolCall = (id: string) =>
  JSON.stringify({
    type: 'assistant',
    sessionId: SESSION,
    timestamp: at(),
    message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] },
  });

const toolResult = (id: string) =>
  JSON.stringify({
    type: 'user',
    sessionId: SESSION,
    timestamp: at(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'a.txt' }] },
  });

/** Claude Code's line for a failed request: `isApiErrorMessage`, model `<synthetic>`. */
const apiError = (
  text: string,
  fields: { apiError?: string; error?: string; stopReason?: string } = {},
) =>
  JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    sessionId: SESSION,
    timestamp: at(),
    ...(fields.apiError ? { apiError: fields.apiError } : {}),
    error: fields.error ?? 'server_error',
    isApiErrorMessage: true,
    message: {
      id: 'msg-synthetic',
      model: '<synthetic>',
      role: 'assistant',
      stop_reason: fields.stopReason ?? 'stop_sequence',
      content: [{ type: 'text', text }],
    },
  });

const turnDuration = () =>
  JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 4_000, sessionId: SESSION, timestamp: at() });

const meta = () =>
  JSON.stringify({
    type: 'user',
    isMeta: true,
    sessionId: SESSION,
    timestamp: at(),
    message: { role: 'user', content: 'Caveat: a note the harness adds.' },
  });

const STOPPED = 'API Error: The response stopped arriving. The response above may be incomplete.';

function rows(...lines: string[]): Message[] {
  return parseTranscript(lines.join('\n') + '\n').map((m, i) => ({ ...m, id: i + 1, taskId: 1 }));
}

describe('apiErrorOf (#338)', () => {
  it('reads the kind and Claude Code’s own text off an error line', () => {
    expect(apiErrorOf(apiError(STOPPED, { apiError: 'stream_idle_timeout' }))).toEqual({ kind: 'stopped', text: STOPPED });
  });

  it('sorts each measured shape, newer builds by `apiError`, older ones by the words', () => {
    const kind = (text: string, fields: Parameters<typeof apiError>[1] = {}) => apiErrorOf(apiError(text, fields))?.kind;
    expect(kind(STOPPED)).toBe('stopped');
    expect(kind('API Error: Your computer went to sleep mid-response.', { apiError: 'computer_slept' })).toBe('slept');
    expect(kind('API Error: Connection lost while your computer was asleep')).toBe('slept');
    expect(kind("API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)", { apiError: 'connection_failed' })).toBe('offline');
    expect(kind("API Error: Can't reach the API server (ENOTFOUND)")).toBe('offline');
    expect(kind('Login expired · Please run /login', { error: 'authentication_failed' })).toBe('signed-out');
    expect(kind('API Error: Rate limit reached', { error: 'rate_limit' })).toBe('rate-limited');
    expect(kind('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toBe('overloaded');
    expect(kind('API Error: something new', { error: 'invalid_request' })).toBe('other');
  });

  it('is null for every other line, Claude’s replies included', () => {
    expect(apiErrorOf(reply('API Error: is a phrase Claude may well write'))).toBeNull();
    expect(apiErrorOf(prompt('isApiErrorMessage'))).toBeNull();
    expect(apiErrorOf(turnDuration())).toBeNull();
    expect(apiErrorOf('{"type":"assistant","isApiErrorMessage":tr')).toBeNull();
  });
});

describe('lastApiError: the last turn stopped on an API error (#338)', () => {
  it('is set when the error line ends the session, past the turn_duration after it', () => {
    const r = rows(prompt('Sort the inbox'), apiError(STOPPED, { apiError: 'stream_idle_timeout' }), turnDuration());
    expect(lastApiError(r)).toEqual({ kind: 'stopped', text: STOPPED });
    // Status is unchanged by it: the turn handed control back, so idle.
    expect(deriveStatus(r, T0 + 60_000)).toBe('idle');
  });

  it('looks past isMeta lines too', () => {
    expect(lastApiError(rows(prompt('Go'), apiError(STOPPED), turnDuration(), meta()))).not.toBeNull();
  });

  it('clears as soon as a new prompt goes in, before any reply', () => {
    const r = rows(prompt('Go'), apiError(STOPPED), turnDuration(), prompt('try again'));
    expect(lastApiError(r)).toBeNull();
    expect(apiErrorTail(r)).toBeNull();
  });

  it('clears when the session goes on by itself: a reply, a tool result', () => {
    expect(lastApiError(rows(prompt('Go'), apiError(STOPPED), reply('Picking up where I was.')))).toBeNull();
    expect(lastApiError(rows(prompt('Go'), toolCall('t1'), apiError(STOPPED), toolResult('t1')))).toBeNull();
  });

  it('is not an error that came mid-turn on a tool call: Claude Code runs the tool and goes on', () => {
    expect(lastApiError(rows(prompt('Go'), toolCall('t1'), apiError(STOPPED, { stopReason: 'tool_use' })))).toBeNull();
  });

  it('is an older error only while nothing came after it', () => {
    const r = rows(prompt('Go'), apiError(STOPPED), turnDuration(), prompt('try again'), reply('Done.'));
    expect(lastApiError(r)).toBeNull();
    expect(lastApiError(rows(prompt('Go'), reply('Done.'), turnDuration()))).toBeNull();
    expect(lastApiError([])).toBeNull();
  });

  it('hands back the row itself, for the transcript’s Try Again', () => {
    const r = rows(prompt('Go'), apiError(STOPPED), turnDuration());
    expect(apiErrorTail(r)?.id).toBe(2);
  });

  it('orders by time, not by the order handed in', () => {
    const r = rows(prompt('Go'), apiError(STOPPED), turnDuration());
    expect(lastApiError([...r].reverse())).not.toBeNull();
  });
});
