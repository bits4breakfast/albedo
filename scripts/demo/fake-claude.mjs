#!/usr/bin/env node
// The demo profile's `claude`: a scripted stand-in, first on the demo PATH.
//
// It plays back a made-up session through the same doors a real one uses:
// it appends transcript lines to ~/.claude/projects, and it runs the hook
// and status-line commands Albedo passed in --settings, with the payloads
// Claude Code sends. So the waiting card, Running, and the plan meters come
// out of the real pipe, and Allow or Deny on the card is answered by the real
// hook script. It runs no model and opens no connection.
//
// Only the demo profile ever runs this (scripts/demo/demo.mjs puts it on the
// PATH of a separate HOME). Its terminal says what it is.

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const after = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] ?? null : null;
};

const sessionId = after('--session-id') ?? after('--resume');
let settings = {};
try {
  settings = JSON.parse(after('--settings') ?? '{}');
} catch {
  settings = {};
}

const home = homedir();
const playsDir = join(home, '.albedo-demo', 'plays');
const play = sessionId && existsSync(join(playsDir, `${sessionId}.json`))
  ? JSON.parse(readFileSync(join(playsDir, `${sessionId}.json`), 'utf8'))
  : null;

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const say = (s = '') => process.stdout.write(`${s}\r\n`);

say(bold(' Albedo demo profile'));
say(dim(' A scripted stand-in for Claude Code, for screenshots. It plays back a'));
say(dim(' made-up session: no model runs here and nothing goes over the network.'));
say();
if (!play) {
  say(` No script for this session${sessionId ? ` (${sessionId})` : ''}.`);
  say(dim(' New tasks in the demo profile have nothing to play.'));
}

// ---------------------------------------------------------------------------
// Hooks: run the command Albedo configured, with Claude Code's payload
// ---------------------------------------------------------------------------

function hookCommands(event) {
  const groups = settings.hooks?.[event] ?? [];
  return groups.flatMap((g) => (g.hooks ?? []).map((h) => h.command)).filter(Boolean);
}

function runCommand(command, payload) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => resolve(out));
    child.on('error', () => resolve(''));
    child.stdin.end(JSON.stringify(payload));
  });
}

const common = () => ({
  session_id: sessionId,
  transcript_path: play?.transcript ?? '',
  cwd: process.cwd(),
  permission_mode: 'default',
});

async function hook(event, extra = {}) {
  const outs = [];
  for (const command of hookCommands(event)) {
    outs.push(await runCommand(command, { ...common(), hook_event_name: event, ...extra }));
  }
  return outs;
}

/** Claude Code's status-line payload, with the fields the meters read. */
async function statusLine() {
  const command = settings.statusLine?.command;
  if (!command || !play) return;
  const s = play.status;
  const hour = 3_600_000;
  await runCommand(command, {
    session_id: sessionId,
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    context_window: {
      context_window_size: 200000,
      used_percentage: s.context,
      remaining_percentage: 100 - s.context,
    },
    rate_limits: {
      five_hour: { used_percentage: s.session, resets_at: Math.floor((Date.now() + 2.3 * hour) / 1000) },
      seven_day: { used_percentage: s.week, resets_at: Math.floor((Date.now() + 3.2 * 24 * hour) / 1000) },
    },
  });
}

// ---------------------------------------------------------------------------
// The transcript: lines are moved in time so the last one is "now"
// ---------------------------------------------------------------------------

function append(lines, endAt) {
  if (!lines || lines.length === 0) return;
  const last = Math.max(...lines.map((l) => Date.parse(l.timestamp)));
  const shift = endAt - last;
  const text = lines
    .map((l) => JSON.stringify({ ...l, timestamp: new Date(Date.parse(l.timestamp) + shift).toISOString() }))
    .join('\n');
  mkdirSync(play.transcriptDir, { recursive: true });
  appendFileSync(play.transcript, `${text}\n`);
}

/** Lines that follow an answer start at the answer and go forward. */
function appendFrom(lines, startAt) {
  if (!lines || lines.length === 0) return;
  const first = Math.min(...lines.map((l) => Date.parse(l.timestamp)));
  const last = Math.max(...lines.map((l) => Date.parse(l.timestamp)));
  append(lines, startAt + (last - first));
}

/** What already happened in this session, across restarts of the demo app. */
const stateFile = play ? join(playsDir, `${sessionId}.state.json`) : null;
const state = stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const save = () => stateFile && writeFileSync(stateFile, JSON.stringify(state));

async function main() {
  await hook('SessionStart', { source: args.includes('--resume') ? 'resume' : 'startup' });
  await statusLine();
  setInterval(statusLine, 60_000);
  if (!play) return;

  say(` ${play.title}`);
  say(dim(` ${play.cwd}`));
  say();

  if (play.live && !state.played) {
    append(play.live, Date.now());
    state.played = true;
    save();
  }
  if (play.outcomes && !state.answered) {
    const { request } = play.outcomes;
    say(` Waiting for permission: ${request.tool_name}(${request.tool_input.command})`);
    say(dim(' Answer it on the card in Albedo.'));
    const [out = ''] = await hook('PermissionRequest', {
      tool_name: request.tool_name,
      tool_input: request.tool_input,
      permission_suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: request.tool_name, ruleContent: request.rule }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    });
    let decision = null;
    try {
      decision = JSON.parse(out).hookSpecificOutput?.decision ?? null;
    } catch {
      decision = null;
    }
    const behavior = decision?.behavior;
    if (behavior === 'allow' || behavior === 'deny') {
      let lines = play.outcomes[behavior];
      // A refusal reaches Claude as the hook's own message.
      if (behavior === 'deny' && typeof decision.message === 'string') {
        lines = lines.map((l, i) =>
          i === 0 ? { ...l, message: { ...l.message, content: [{ ...l.message.content[0], content: decision.message }] } } : l,
        );
      }
      appendFrom(lines, Date.now());
      state.answered = behavior;
      save();
      say(` ${behavior === 'allow' ? 'Allowed' : 'Denied'} on the card.`);
      if (behavior === 'allow') await hook('Stop');
    }
  }
}

const quit = () => process.exit(0);
process.on('SIGHUP', quit);
process.on('SIGTERM', quit);
process.on('SIGINT', quit);
// Typed input goes nowhere; the stand-in only plays its script.
process.stdin.resume();
process.stdin.on('end', quit);
main();
