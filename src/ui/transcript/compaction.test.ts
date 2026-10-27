// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import fixture from '../../capture/fixtures/compaction.jsonl?raw';
import { parseTranscript } from '../../capture/adapter';
import type { Message } from '../../types';
import { compactionAt, compactionLabel, isPromptRow, noticeParts } from './compaction';
import { groupRows } from './TranscriptPane';

/** The fixture as stored rows: ids in file order. */
const rows: Message[] = parseTranscript(fixture).map((r, i) => ({ ...r, id: i + 1, taskId: 1 }));
const bySeq = (seq: number) => rows.find((r) => r.seq === seq) as Message;
const boundary = bySeq(200);
const summary = bySeq(300);
const notice = bySeq(600);

/** Task-scoped reads order by ts (db/index.ts messageOrderKeys), then seq. */
const byTs = [...rows].sort((a, b) => a.ts - b.ts || a.seq - b.seq);

describe('compactionAt', () => {
  it('pairs the boundary and the summary in file order, as the tail reads them', () => {
    const at = compactionAt(rows, rows.indexOf(boundary));
    expect(at?.compaction.boundary).toBe(boundary);
    expect(at?.compaction.summary).toBe(summary);
    expect(at?.compaction.meta?.trigger).toBe('auto');
    expect(at?.compaction.summaryText?.startsWith('This session is being continued')).toBe(true);
  });

  it('pairs them the same way when ts puts the summary first, as the window reads them', () => {
    expect(byTs.indexOf(summary)).toBeLessThan(byTs.indexOf(boundary));
    const at = compactionAt(byTs, byTs.indexOf(summary));
    expect(at?.compaction.boundary).toBe(boundary);
    expect(at?.compaction.summary).toBe(summary);
  });

  it('takes the notice written right after the pair, and steps past all three', () => {
    for (const list of [rows, byTs]) {
      const start = Math.min(list.indexOf(boundary), list.indexOf(summary));
      const at = compactionAt(list, start);
      expect(at?.compaction.notice).toBe(notice);
      expect(at?.next).toBe(list.indexOf(notice) + 1);
    }
  });

  it('leaves a notice that is not right after a compaction alone', () => {
    const list = [boundary, summary, bySeq(700), notice];
    expect(compactionAt(list, 0)?.compaction.notice).toBeNull();
    expect(compactionAt(list, 0)?.next).toBe(2);
  });

  it('does not pair across sessions or with another boundary', () => {
    const other = { ...summary, id: 99, sessionId: 'other' };
    expect(compactionAt([boundary, other], 0)?.compaction.summary).toBeNull();
    const second = bySeq(800);
    expect(compactionAt([second, summary], 0)?.compaction.summary).toBeNull();
  });

  it('keeps a summary whose boundary is outside the window as a compaction, never a message', () => {
    const at = compactionAt([summary, bySeq(700)], 0);
    expect(at?.compaction.boundary).toBeNull();
    expect(at?.compaction.summary).toBe(summary);
    expect(at?.next).toBe(1);
  });

  it('is null for any other row', () => {
    for (const seq of [0, 100, 600, 700]) expect(compactionAt(rows, rows.indexOf(bySeq(seq)))).toBeNull();
  });
});

describe('groupRows with a compaction', () => {
  it('makes one item per compaction, in both orders, and no "you" row for a summary', () => {
    for (const list of [rows, byTs]) {
      const items = groupRows(list);
      expect(items.map((i) => (i.kind === 'row' ? i.message.seq : i.kind))).toEqual([0, 100, 'compaction', 700, 'compaction']);
      const summaries = new Set([summary.id, bySeq(900).id]);
      for (const i of items) if (i.kind === 'row') expect(summaries.has(i.message.id)).toBe(false);
    }
  });

  it('keys the item by its boundary, so the two reads do not remount it', () => {
    const key = (list: Message[]) => groupRows(list).find((i) => i.kind === 'compaction')?.key;
    expect(key(rows)).toBe(key(byTs));
  });
});

describe('isPromptRow', () => {
  it('is false for a summary, true for what was typed', () => {
    expect(isPromptRow(summary)).toBe(false);
    expect(isPromptRow(bySeq(700))).toBe(true);
    expect(isPromptRow(boundary)).toBe(false);
  });
});

describe('compactionLabel', () => {
  it('says what the boundary recorded', () => {
    expect(compactionLabel({ uuid: 'b', trigger: 'auto', preTokens: 284738, durationMs: 62969 })).toBe(
      'Context Compacted · 285k tokens · took 1m 3s',
    );
    expect(compactionLabel({ uuid: 'b', trigger: 'manual', preTokens: 221_000, durationMs: 54_000 })).toBe(
      'Context Compacted · by /compact · 221k tokens · took 54s',
    );
  });

  it('leaves out what it does not know', () => {
    expect(compactionLabel(null)).toBe('Context Compacted');
    expect(compactionLabel({ uuid: null, trigger: null, preTokens: null, durationMs: null })).toBe('Context Compacted');
  });
});

describe('noticeParts', () => {
  it('splits the statement from its hint at the middle dot', () => {
    const text = (notice.body ?? '').trim();
    expect(noticeParts(text)).toEqual({ line: 'Compacted while idle, before the prompt cache expired', title: text });
  });

  it('keeps a notice without a hint whole', () => {
    expect(noticeParts('Compacted while idle')).toEqual({ line: 'Compacted while idle', title: 'Compacted while idle' });
  });
});
