/**
 * #362: what live appends cost and keep.
 *
 *  - A stored row's raw line is parsed once, however many questions the pane
 *    asks of it, and a changed line is never answered from the old parse.
 *  - A tool result written in a later chunk than its call still names the
 *    tool, when the chunks come from the same file.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FILE_PAIRING_MAX_CALLS,
  __clearRowParseCache,
  __resetFilePairings,
  __rowParseCacheStats,
  countLines,
  cwdOf,
  lastTitleIn,
  permissionModesIn,
  queueFactsIn,
  remoteSessionFactsIn,
  skillListingsIn,
  isMetaLine,
  parseLine,
  parseTranscript,
  toolInputOf,
  toolResultIsErrorOf,
  toolUseIdOf,
  turnEdgeOf,
} from './adapter';

afterEach(() => {
  vi.restoreAllMocks();
  __resetFilePairings();
});

let n = 0;
const ts = () => new Date(Date.parse('2026-11-12T10:00:00.000Z') + ++n * 1000).toISOString();

function callLine(id: string, name: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 's',
    timestamp: ts(),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
}
function resultLine(id: string, text = 'ok', isError = false): string {
  return JSON.stringify({
    type: 'user',
    sessionId: 's',
    timestamp: ts(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] },
  });
}
function rowOf(raw: string, line = 1) {
  const [m] = parseLine(raw, line);
  return { ...m!, id: line };
}

describe('row parse cache', () => {
  it('parses a row once, however many questions are asked of it (fails before #362)', () => {
    const raw = callLine(`tu-once-${n}`, 'Edit', { file_path: '/a.ts', old_string: 'a', new_string: 'b' });
    const m = rowOf(raw);
    const parse = vi.spyOn(JSON, 'parse');
    for (let i = 0; i < 5; i++) {
      toolUseIdOf(m);
      toolInputOf(m);
      turnEdgeOf(m.rawJson);
      toolResultIsErrorOf(m);
    }
    expect(parse.mock.calls.filter(([s]) => s === raw).length).toBeLessThanOrEqual(1);
  });

  it('answers the same as an uncached read, for a fresh object holding the same line', () => {
    const raw = callLine('tu-same', 'Bash', { command: 'ls -la' });
    const a = rowOf(raw);
    const b = { ...rowOf(raw) };
    expect(toolUseIdOf(a)).toBe('tu-same');
    expect(toolUseIdOf(b)).toBe('tu-same');
    expect(toolInputOf(b)).toEqual({ command: 'ls -la' });
  });

  it('never answers a changed line from the old parse: the line itself is the key', () => {
    const first = rowOf(callLine('tu-v1', 'Bash', { command: 'one' }));
    expect(toolInputOf(first)).toEqual({ command: 'one' });
    // Same row id and seq, different line: as if the row had been rewritten.
    const changed = { ...first, rawJson: callLine('tu-v2', 'Bash', { command: 'two' }) };
    expect(toolInputOf(changed)).toEqual({ command: 'two' });
    expect(toolUseIdOf(changed)).toBe('tu-v2');
    expect(toolInputOf(first)).toEqual({ command: 'one' });
  });

  it('hands out a frozen value, so no caller can change what later reads see', () => {
    const m = rowOf(callLine('tu-frozen', 'Bash', { command: 'ls', nested: { a: 1 } }));
    const input = toolInputOf(m);
    expect(Object.isFrozen(input)).toBe(true);
    expect(() => {
      (input as Record<string, unknown>)['command'] = 'rm -rf /';
    }).toThrow(TypeError);
    expect(() => {
      ((input['nested'] as Record<string, unknown>) ?? {})['a'] = 2;
    }).toThrow(TypeError);
    expect(toolInputOf(m)).toEqual({ command: 'ls', nested: { a: 1 } });
  });

  it('a line that does not parse still reads as nothing, and keeps doing so', () => {
    expect(turnEdgeOf('{not json')).toBeNull();
    expect(turnEdgeOf('{not json')).toBeNull();
    expect(isMetaLine('')).toBe(false);
  });

  it('stays bounded by entries and by characters', () => {
    const { maxEntries, maxChars } = __rowParseCacheStats();
    for (let i = 0; i < maxEntries + 500; i++) isMetaLine(`{"type":"user","i":${i}}`);
    const after = __rowParseCacheStats();
    expect(after.entries).toBeLessThanOrEqual(maxEntries);
    expect(after.chars).toBeLessThanOrEqual(maxChars);

    const big = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 40; i++) isMetaLine(`{"type":"user","isMeta":true,"pad":"${big}","i":${i}}`);
    expect(__rowParseCacheStats().chars).toBeLessThanOrEqual(maxChars);
    // Still answered right after eviction.
    expect(isMetaLine(`{"type":"user","isMeta":true,"pad":"${big}","i":0}`)).toBe(true);
  });

  it('ingest never fills it: chunk lines are slices that would keep the whole chunk alive', () => {
    const chunk = [
      JSON.stringify({ type: 'user', sessionId: 's', cwd: '/w', timestamp: ts(), message: { role: 'user', content: 'go' } }),
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: 's', timestamp: ts(), content: 'later' }),
      callLine('tu-ingest', 'Edit', { file_path: '/a.ts', old_string: 'a', new_string: 'b' }),
      resultLine('tu-ingest'),
      JSON.stringify({
        type: 'assistant',
        sessionId: 's',
        cwd: '/w',
        timestamp: ts(),
        message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
      }),
      JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: 's', timestamp: ts() }),
      JSON.stringify({ type: 'custom-title', customTitle: 't', sessionId: 's' }),
      '',
    ].join('\n');
    __clearRowParseCache();
    const rows = parseTranscript(chunk, 0, '/ingest.jsonl');
    expect(rows.length).toBeGreaterThan(0);
    expect(queueFactsIn(chunk).some((f) => f.op === 'turn-end')).toBe(true);
    lastTitleIn(chunk);
    permissionModesIn(chunk);
    remoteSessionFactsIn(chunk);
    skillListingsIn(chunk);
    countLines(chunk);
    for (const r of rows) cwdOf(r.rawJson);
    for (const line of chunk.split('\n')) cwdOf(line);
    expect(__rowParseCacheStats().entries).toBe(0);
  });

  it('a line too long to hold is still read correctly, every time', () => {
    const huge = `{"type":"user","isMeta":true,"pad":"${'y'.repeat(5 * 1024 * 1024)}"}`;
    const before = __rowParseCacheStats().entries;
    expect(isMetaLine(huge)).toBe(true);
    expect(isMetaLine(huge)).toBe(true);
    expect(__rowParseCacheStats().entries).toBeLessThanOrEqual(before);
  });
});

describe('tool result pairing across chunks of one file', () => {
  it('names the tool on a result written in a later chunk (fails before #362)', () => {
    const call = callLine('tu-later', 'Edit', { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' });
    const first = parseTranscript(`${call}\n`, 0, '/p/s.jsonl');
    expect(first[0]).toMatchObject({ role: 'tool_use', toolName: 'Edit', targetPath: '/w/a.ts' });

    const [res] = parseTranscript(`${resultLine('tu-later')}\n`, 1, '/p/s.jsonl');
    expect(res).toMatchObject({ role: 'tool_result', toolName: 'Edit', targetPath: '/w/a.ts' });
  });

  it('pairs exactly as before within one chunk, and without a file pairs only within the text', () => {
    const call = callLine('tu-one', 'Read', { file_path: '/w/b.ts' });
    const whole = parseTranscript(`${call}\n${resultLine('tu-one')}\n`);
    expect(whole[1]).toMatchObject({ role: 'tool_result', toolName: 'Read', targetPath: '/w/b.ts' });

    // No file: a later chunk knows nothing of the earlier one (brief.ts reads whole files).
    parseTranscript(`${call}\n`, 0);
    const [alone] = parseTranscript(`${resultLine('tu-one')}\n`, 1);
    expect(alone).toMatchObject({ role: 'tool_result', toolName: null, targetPath: null });
  });

  it('keeps each file to its own calls', () => {
    parseTranscript(`${callLine('tu-a', 'Bash', { command: 'ls' })}\n`, 0, '/p/a.jsonl');
    const [other] = parseTranscript(`${resultLine('tu-a')}\n`, 5, '/p/b.jsonl');
    expect(other!.toolName).toBeNull();
  });

  it('starts afresh when a file is read again from its first line', () => {
    parseTranscript(`${callLine('tu-r', 'Bash', { command: 'ls' })}\n`, 0, '/p/r.jsonl');
    // Rewritten: the next chunk is line 0 again, and it carries only the result.
    const [res] = parseTranscript(`${resultLine('tu-r')}\n`, 0, '/p/r.jsonl');
    expect(res!.toolName).toBeNull();
  });

  it('a chunk read again (an insert that failed and is retried) pairs the same way', () => {
    const file = '/p/retry.jsonl';
    parseTranscript(`${callLine('tu-x', 'Write', { file_path: '/w/x.ts', content: 'x' })}\n`, 0, file);
    const chunk = `${resultLine('tu-x')}\n`;
    const once = parseTranscript(chunk, 1, file);
    const again = parseTranscript(chunk, 1, file);
    expect(again).toEqual(once);
    expect(again[0]!.toolName).toBe('Write');
  });

  it('remembers a bounded number of calls per file, newest kept', () => {
    const file = '/p/many.jsonl';
    const lines = Array.from({ length: FILE_PAIRING_MAX_CALLS + 10 }, (_, i) => callLine(`tu-m${i}`, 'Bash', { command: `c${i}` }));
    parseTranscript(`${lines.join('\n')}\n`, 0, file);
    const [oldest] = parseTranscript(`${resultLine('tu-m0')}\n`, lines.length, file);
    const [newest] = parseTranscript(`${resultLine(`tu-m${lines.length - 1}`)}\n`, lines.length + 1, file);
    expect(oldest!.toolName).toBeNull();
    expect(newest!.toolName).toBe('Bash');
  });
});
