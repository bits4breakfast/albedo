// Builds Claude Code transcript lines for the demo profile's made-up sessions.
//
// The shapes copy what Claude Code 2.1.3xx writes (see
// src/capture/fixtures/session-basic.jsonl and docs/TRANSCRIPT-FORMAT.md), so
// the app reads these exactly as it reads a real session. This is fixture
// writing, like the fixtures beside the adapter: the app still learns the
// format only through src/capture/adapter.ts.

import { randomUUID } from 'node:crypto';

export const CLAUDE_VERSION = '2.1.314';
export const MODEL = 'claude-opus-5-5';

/** Claude Code's folder for a session that ran in `cwd` (see transcriptPathFor). */
export function projectDirName(cwd) {
  return cwd.replace(/\/+$/, '').replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * A session's lines, written as a conversation: `user`, `say`, `tool` and
 * `end` each add what Claude Code would write, stamped from a clock that the
 * caller moves on with `wait`.
 */
export function session({ sessionId, cwd, branch, startAt }) {
  const lines = [];
  let at = startAt;
  let parent = null;
  let n = 0;
  let turnStart = startAt;
  /** The last tool call made with no result: what `result` answers. */
  let openCall = null;

  const base = (type) => {
    const uuid = randomUUID();
    const line = {
      parentUuid: parent,
      isSidechain: false,
      userType: 'external',
      cwd,
      sessionId,
      version: CLAUDE_VERSION,
      gitBranch: branch,
      type,
      uuid,
      timestamp: new Date(at).toISOString(),
    };
    parent = uuid;
    return line;
  };

  const assistant = (content, stopReason) => {
    n += 1;
    const line = base('assistant');
    line.message = {
      model: MODEL,
      id: `msg_demo_${sessionId.slice(0, 8)}_${n}`,
      type: 'message',
      role: 'assistant',
      stop_reason: stopReason,
      content,
      usage: {
        input_tokens: 6,
        cache_creation_input_tokens: 900 + n * 40,
        cache_read_input_tokens: 18000 + n * 1500,
        output_tokens: 120 + n * 10,
        service_tier: 'standard',
      },
    };
    lines.push(line);
  };

  const api = {
    lines,
    now: () => at,
    wait(ms) {
      at += ms;
      return api;
    },
    /** What you typed. Starts a turn. */
    user(text) {
      turnStart = at;
      const line = base('user');
      line.message = { role: 'user', content: text };
      lines.push(line);
      return api;
    },
    /** Claude's prose, mid-turn. */
    say(text) {
      assistant([{ type: 'text', text }], null);
      return api;
    },
    /**
     * A tool call. With `result` it is answered (after `took` ms); without, it
     * is left running, which is how a session looks mid-command.
     */
    tool(name, input, result, opts = {}) {
      const id = `toolu_demo${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      assistant([{ type: 'tool_use', id, name, input }], 'tool_use');
      if (result === undefined) {
        openCall = { id, name, input };
        return api;
      }
      at += opts.took ?? 1500;
      const line = base('user');
      const text = typeof result === 'string' ? result : result.text;
      line.message = {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(opts.isError ? { is_error: true } : {}) }],
      };
      line.toolUseResult = toolUseResult(name, input, text);
      lines.push(line);
      return api;
    },
    /** The answer to a tool call already made with `tool` and no result. */
    result(text, opts = {}) {
      if (!openCall) throw new Error('result(): no tool call to answer');
      const { id, name, input } = openCall;
      openCall = null;
      const line = base('user');
      line.message = {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(opts.isError ? { is_error: true } : {}) }],
      };
      line.toolUseResult = opts.isError ? `Error: ${text}` : toolUseResult(name, input, text);
      lines.push(line);
      return api;
    },
    /** Claude's last words in a turn, and the turn's end. */
    end(text) {
      assistant([{ type: 'text', text }], 'end_turn');
      at += 200;
      const line = base('system');
      Object.assign(line, {
        subtype: 'turn_duration',
        isMeta: true,
        durationMs: at - turnStart,
        messageCount: lines.length,
      });
      lines.push(line);
      return api;
    },
    /**
     * A second conversation that carries on from here, for an outcome that is
     * not decided yet (Allow or Deny on the waiting card). Lines added to the
     * fork are its own. `startAt` restarts its clock (the live part of a
     * session is timed from zero and moved to "now" when it is played).
     */
    fork(startAt = at) {
      const child = session({ sessionId, cwd, branch, startAt });
      child._adopt({ parent, n, turnStart, openCall });
      return child;
    },
    _adopt(state) {
      ({ parent, n, turnStart, openCall } = state);
    },
    jsonl() {
      return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    },
  };
  return api;
}

function toolUseResult(name, input, text) {
  switch (name) {
    case 'Read':
      return {
        type: 'text',
        file: { filePath: input.file_path, content: text, numLines: text.split('\n').length, startLine: 1, totalLines: text.split('\n').length },
      };
    case 'Edit':
      return {
        filePath: input.file_path,
        oldString: input.old_string,
        newString: input.new_string,
        originalFile: null,
        structuredPatch: [],
        userModified: false,
        replaceAll: false,
      };
    case 'Write':
      return { type: 'create', filePath: input.file_path, content: input.content, structuredPatch: [], originalFile: null };
    case 'Bash':
      return { stdout: text, stderr: '', interrupted: false, isImage: false, noOutputExpected: false };
    default:
      return text;
  }
}
