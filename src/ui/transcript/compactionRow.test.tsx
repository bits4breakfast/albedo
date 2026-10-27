/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import fixture from '../../capture/fixtures/compaction.jsonl?raw';
import { parseTranscript } from '../../capture/adapter';
import type { Message } from '../../types';
import CompactionRow from './CompactionRow';
import { compactionAt } from './compaction';
import { splitCompactSummary } from './envelopes';

afterEach(cleanup);

const rows: Message[] = parseTranscript(fixture).map((r, i) => ({ ...r, id: i + 1, taskId: 1 }));
const at = (seq: number) => compactionAt(rows, rows.findIndex((r) => r.seq === seq))?.compaction;

describe('CompactionRow', () => {
  it('is one divider with the summary folded, closed by default', () => {
    const { container } = render(<CompactionRow compaction={at(200)!} />);
    const head = screen.getByRole('button');
    expect(head.textContent).toContain('Context Compacted · 285k tokens · took 1m 3s');
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('This session is being continued');
    expect(container.querySelector('.tx-gutter')?.textContent).toBe('');
  });

  it('shows the idle notice as a quiet line, with the hint as its tooltip', () => {
    render(<CompactionRow compaction={at(200)!} />);
    const note = screen.getByText('Compacted while idle, before the prompt cache expired');
    expect(note.className).toBe('tx-compacted-note');
    expect(note.getAttribute('title')).toContain('"idleCompaction": false');
  });

  it('opens onto the summary as markdown, with the tools as a quiet line instead of the tag', () => {
    const { container } = render(<CompactionRow compaction={at(200)!} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Tools used before: Bash, Edit, Read')).toBeTruthy();
    expect(container.textContent).toContain('This session is being continued');
    expect(container.textContent).not.toContain('tools-used-before-summary');
    expect(container.querySelector('.tx-compacted-body strong')?.textContent).toBe('retry helper');
  });

  it('says the compaction was asked for when the transcript says so', () => {
    render(<CompactionRow compaction={at(800)!} />);
    expect(screen.getByRole('button').textContent).toContain('Context Compacted · by /compact · 120k tokens · took 41s');
  });

  it('draws a boundary without its summary as a plain divider, with no caret onto nothing', () => {
    const boundary = rows.find((r) => r.seq === 200)!;
    render(<CompactionRow compaction={compactionAt([boundary], 0)!.compaction} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Context Compacted · 285k tokens · took 1m 3s')).toBeTruthy();
  });
});

describe('splitCompactSummary', () => {
  it('lifts the tools envelope out of the text', () => {
    const { tools, text } = splitCompactSummary('Intro.\n\n<tools-used-before-summary>Agent, Bash</tools-used-before-summary>\nSummary:\n1. Done.');
    expect(tools).toEqual(['Agent', 'Bash']);
    expect(text).toBe('Intro.\n\nSummary:\n1. Done.');
  });

  it('returns a summary without the envelope whole', () => {
    expect(splitCompactSummary('Summary:\n1. Done.')).toEqual({ tools: [], text: 'Summary:\n1. Done.' });
  });
});
