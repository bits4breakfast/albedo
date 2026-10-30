/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import skills from '../../capture/fixtures/skill-load.jsonl?raw';
import { parseTranscript } from '../../capture/adapter';
import type { Message } from '../../types';
import { MessageRow } from './MessageRow';
import { echoLanded, groupRows } from './TranscriptPane';
import { isPromptRow } from './compaction';
import { workingState } from './working';

afterEach(cleanup);

/**
 * Claude's Skill call, "Launching skill: …" as its result, then the skill's
 * text as an `isMeta` user line naming the call (`sourceToolUseID`). The text
 * read as "You" until #150, and the chip said only "Skill".
 */
const rows: Message[] = parseTranscript(skills).map((r, i) => ({ ...r, id: i + 1, taskId: 1 }));
const main = rows.filter((m) => m.agentId === null);
const side = rows.filter((m) => m.agentId !== null);

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

const chipHeads = (container: HTMLElement) => [...container.querySelectorAll('.tx-chip-head')].map((h) => h.textContent);

describe('a loaded skill in the transcript', () => {
  it('folds the text into its Skill call: no row of its own', () => {
    const items = groupRows(main);
    const calls = items.flatMap((i) => (i.kind === 'row' && i.message.role === 'tool_use' ? [i] : []));
    expect(calls.map((c) => (c.kind === 'row' ? (c.extras ?? []).map((e) => e.id) : []))).toEqual([[4], [7]]);
    const ids = items.flatMap((i) => (i.kind === 'row' ? [i.message.id] : []));
    expect(ids).not.toContain(4);
    expect(ids).not.toContain(7);
  });

  it('names the skill on the chip, with its args; only the typed prompt is "You"', () => {
    const { container } = renderItems(main);
    expect(chipHeads(container)).toEqual(['Skillchart-maker✓', 'Skillnote-taker · weekly summary for the team✓']);
    const gutters = [...container.querySelectorAll('.tx-gutter')].map((g) => g.textContent);
    expect(gutters.filter((g) => g === 'You')).toHaveLength(1);
    expect(container.querySelector('.tx-row-user')?.textContent).toContain('Draw a bar chart');
    // Folded with the chip: the text shows only once it is opened.
    expect(container.textContent).not.toContain('Label every axis');
    expect(container.textContent).not.toContain('Write notes as short bullets');
  });

  it('shows the skill text as markdown when its chip opens', () => {
    const { container } = renderItems(main);
    const [first] = screen.getAllByRole('button', { name: 'Skill details' });
    fireEvent.click(first as HTMLElement);
    const chip = container.querySelector('.tx-chip-open') as HTMLElement;
    const section = within(chip).getByRole('heading', { name: 'Instructions' }).closest('section') as HTMLElement;
    expect(section.textContent).toContain('Chart Maker');
    expect([...section.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Use bars for categories.', 'Label every axis.']);
    expect(section.textContent).not.toContain('# Chart Maker');
  });

  it('shows where a plugin or user skill lives, and not the base-directory line itself', () => {
    const { container } = renderItems(main);
    const [, second] = screen.getAllByRole('button', { name: 'Skill details' });
    fireEvent.click(second as HTMLElement);
    const section = within(container.querySelector('.tx-chip-open') as HTMLElement)
      .getByRole('heading', { name: 'Instructions' })
      .closest('section') as HTMLElement;
    expect(section.querySelector('.tx-chip-desc')?.textContent).toBe('/Users/example/.claude/skills/note-taker');
    expect(section.textContent).toContain('Write notes as short bullets.');
    expect(section.textContent).not.toContain('Base directory for this skill');
  });

  it('keeps the "already loaded" note a Sys row', () => {
    const { container } = renderItems(main);
    const sys = [...container.querySelectorAll('.tx-row-system')].map((r) => r.textContent);
    expect(sys.some((t) => t?.includes('is already loaded above'))).toBe(true);
  });
});

describe('a skill text whose Skill call is not loaded', () => {
  it('draws as a folded Skill Loaded row, not "You", for a built-in skill', () => {
    const { container } = renderItems(main.filter((m) => m.id !== 2));
    const row = [...container.querySelectorAll('.tx-row')].find((r) => r.textContent?.includes('Skill Loaded')) as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.className).toContain('tx-row-machine');
    expect(row.querySelector('.tx-gutter')?.textContent).toBe('');
    expect(row.textContent?.trim()).toBe('Skill Loaded');
    expect(container.textContent).not.toContain('Label every axis');
    fireEvent.click(within(row).getByRole('button', { name: /Skill Loaded/ }));
    expect(row.textContent).toContain('Label every axis.');
    const gutters = [...container.querySelectorAll('.tx-gutter')].map((g) => g.textContent);
    expect(gutters.filter((g) => g === 'You')).toHaveLength(1);
  });

  it('names a plugin skill from its directory, as before', () => {
    const { container } = render(<MessageRow message={main[6] as Message} />);
    expect(screen.getByRole('button', { name: /Skill Loaded · note-taker/ })).toBeTruthy();
    expect(container.querySelector('.tx-gutter')?.textContent).toBe('');
  });
});

describe('a loaded skill in a subagent', () => {
  it('folds into its call inside the subagent group', () => {
    const items = groupRows(rows);
    const group = items.find((i) => i.kind === 'sidechain');
    expect(group?.kind).toBe('sidechain');
    if (group?.kind !== 'sidechain') return;
    expect(group.rows.map((r) => r.id)).not.toContain(13);
    const call = group.rows.find((r) => r.role === 'tool_use') as Message;
    expect(group.extras.get(call.id)?.map((r) => r.id)).toEqual([13]);
  });

  it('folds into its call in the subagent inspector, which does not fold the group', () => {
    const { container } = renderItems(side, false);
    expect(chipHeads(container)).toEqual(['Skillchart-maker✓']);
    // The one "You" is the prompt the subagent was given, as before.
    expect([...container.querySelectorAll('.tx-gutter')].filter((g) => g.textContent === 'You')).toHaveLength(1);
    expect(container.textContent).not.toContain('Label every axis');
    fireEvent.click(screen.getByRole('button', { name: 'Skill details' }));
    expect(container.textContent).toContain('Label every axis.');
  });
});

describe('a skill text is no prompt', () => {
  const texts = rows.filter((m) => m.id === 4 || m.id === 7 || m.id === 13);

  it('is not a prompt row and does not land an echo', () => {
    for (const m of texts) expect(isPromptRow(m)).toBe(false);
    const at = (texts[0] as Message).ts;
    expect(echoLanded({ at }, [texts[0] as Message])).toBe(false);
  });

  it('does not start the turn the working line counts from', () => {
    // Without the typed prompt and with no turn end loaded, nothing opens the
    // turn: the skill text, which comes after a call, must not.
    const tail = main.slice(1, 7);
    expect(workingState(tail, { sending: false, echoAt: null, complete: true }).turn).toBeNull();
    expect(workingState(main.slice(0, 7), { sending: false, echoAt: null, complete: true }).turn?.startedAt).toBe(
      (main[0] as Message).ts,
    );
  });
});
