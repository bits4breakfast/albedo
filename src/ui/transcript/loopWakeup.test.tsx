/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import loop from '../../capture/fixtures/loop-wakeup.jsonl?raw';
import notes from '../../capture/fixtures/harness-notes.jsonl?raw';
import { parseTranscript } from '../../capture/adapter';
import type { Message } from '../../types';
import { MessageRow } from './MessageRow';
import { echoLanded, groupRows } from './TranscriptPane';
import { isPromptRow } from './compaction';
import { workingState } from './working';

afterEach(cleanup);

/**
 * A `/loop` wake-up writes "Claude resuming /loop wakeup", then (after no-op
 * ticks) a "[N prior /loop wakeups…]" note, then the loop's prompt again, the
 * last two as `isMeta` user lines. Both read as "You" until #138.
 */
const rows: Message[] = parseTranscript(loop).map((r, i) => ({ ...r, id: i + 1, taskId: 1 }));
const noteRows: Message[] = parseTranscript(notes).map((r, i) => ({ ...r, id: i + 1, taskId: 1 }));
const PROMPT_START = 'Check whether the nightly build passed.';

function renderItems(messages: readonly Message[], foldSidechains = true) {
  const items = groupRows(messages, { foldSidechains });
  return render(
    <div>
      {items.map((item) =>
        item.kind === 'row' ? <MessageRow key={item.key} message={item.message} result={item.result} extras={item.extras} /> : null,
      )}
    </div>,
  );
}

describe('a /loop wake-up in the transcript', () => {
  it('is one Sys row per wake-up, with the prompt folded and the note dropped; only the typed prompt is "You"', () => {
    const { container } = renderItems(rows);
    const gutters = [...container.querySelectorAll('.tx-gutter')].map((g) => g.textContent);
    expect(gutters.filter((g) => g === 'You')).toHaveLength(1);
    const wakeups = [...container.querySelectorAll('.tx-row-system')];
    expect(wakeups.map((w) => w.querySelector('.tx-system-text')?.textContent)).toEqual([
      'Claude resuming /loop wakeup (Oct 30 10:14am)',
      'Claude resuming /loop wakeup (Oct 30 10:22am) · 2 no-op ticks since Oct 30 10:14am',
    ]);
    // Folded: the label shows, the prompt does not until asked.
    expect(screen.getAllByRole('button', { name: /Scheduled Prompt/ })).toHaveLength(2);
    expect(container.textContent).not.toContain(PROMPT_START);
    expect(container.textContent).not.toContain('prior /loop wakeups');
    expect(container.querySelector('.tx-row-user')?.textContent).toContain('Watch the nightly build');
  });

  it('shows the prompt once opened, under its wake-up', () => {
    const { container } = renderItems(rows);
    const [first] = screen.getAllByRole('button', { name: /Scheduled Prompt/ });
    fireEvent.click(first as HTMLElement);
    const opened = container.querySelectorAll('.tx-row-system')[0];
    expect(opened?.textContent).toContain(PROMPT_START);
    expect(container.querySelectorAll('.tx-row-system')[1]?.textContent).not.toContain(PROMPT_START);
  });

  it('folds the note and the prompt into the wake-up row, not rows of their own', () => {
    const items = groupRows(rows);
    const wake = items.filter((i) => i.kind === 'row' && i.message.role === 'system' && i.message.body?.startsWith('Claude resuming'));
    expect(wake.map((i) => (i.kind === 'row' ? (i.extras ?? []).map((e) => e.id) : []))).toEqual([[5], [9, 10]]);
    const ids = items.flatMap((i) => (i.kind === 'row' ? [i.message.id] : []));
    expect(ids).not.toContain(5);
    expect(ids).not.toContain(9);
    expect(ids).not.toContain(10);
  });

  it('draws a prompt whose wake-up line is elsewhere as a folded Sys row, not "You"', () => {
    const prompt = rows[4] as Message;
    const { container } = render(<MessageRow message={prompt} />);
    expect(container.querySelector('.tx-gutter')?.textContent).toBe('Sys');
    expect(screen.getByRole('button', { name: /Scheduled Prompt/ })).toBeTruthy();
    expect(container.textContent).not.toContain(PROMPT_START);
  });

  it('never clears the echo of a message being sent', () => {
    // Sent a second before the wake-up; only the wake-up's rows came in.
    const at = (rows[7] as Message).ts - 1000;
    expect(echoLanded({ at }, rows.slice(7, 10))).toBe(false);
    expect(rows.filter(isPromptRow).map((r) => r.id)).toEqual([1]);
    // A typed prompt still does.
    expect(echoLanded({ at: (rows[0] as Message).ts }, rows.slice(0, 1))).toBe(true);
  });

  it('starts the turn the working line times, at the wake-up', () => {
    const w = workingState(rows, { sending: false, echoAt: null, complete: true });
    expect(w.turn?.startedAt).toBe((rows[7] as Message).ts);
    expect(w.turn?.outputTokens).toBe(7);
  });
});

describe("harness notes and the isMeta lines that keep their look", () => {
  it('draws the hand-back reminder in a subagent as Sys, never "You"', () => {
    const { container } = renderItems(noteRows, false);
    const sys = [...container.querySelectorAll('.tx-row-system')].map((r) => r.textContent);
    expect(sys).toHaveLength(2);
    expect(sys[0]).toContain('[handback-send-enforce] Your report has not been delivered.');
    expect(sys[1]).toContain('[Your previous response had no visible output.');
    const you = [...container.querySelectorAll('.tx-row-user')].map((r) => r.textContent);
    // The subagent's prompt (what its parent sent) and the typed prompt, as before.
    expect(you).toHaveLength(2);
    expect(you.join(' ')).not.toContain('handback-send-enforce');
  });

  it('keeps a skill, a peer message and a reminder as they were', () => {
    const { container } = renderItems(noteRows, false);
    expect(container.textContent).toContain('Skill Loaded');
    expect(container.querySelector('.tx-peer-head')?.textContent).toBe('From Fix login');
    expect(screen.getByRole('button', { name: /Injected Context/ })).toBeTruthy();
  });

  it('is not a prompt row, so it clears no echo', () => {
    const enforce = noteRows[2] as Message;
    expect(isPromptRow(enforce)).toBe(false);
    expect(isPromptRow(noteRows[7] as Message)).toBe(true);
  });
});
