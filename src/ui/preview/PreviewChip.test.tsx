/**
 * @vitest-environment jsdom
 *
 * #348: a `show_preview` call in the transcript is a chip per version with
 * how it ended; a click opens that version read only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Message, Preview } from '../../types';

const kept = vi.hoisted(() => ({ byToolUse: new Map<string, unknown>() }));
vi.mock('../../db/previews', () => ({
  onPreviewsChanged: () => () => {},
  previewVersions: async () => [],
  previewByToolUse: async (id: string) => kept.byToolUse.get(id) ?? null,
}));
vi.mock('../theme', () => ({ resolvedTheme: () => 'light' }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const { PreviewChip } = await import('./PreviewChip');
const { PreviewViewerHost } = await import('./previewViewer');
const { parseLine } = await import('../../capture/adapter');

afterEach(() => {
  cleanup();
  kept.byToolUse.clear();
});

function rows(id: string, resultText: string | null, isError = false): { use: Message; result: Message | null } {
  const use = parseLine(
    JSON.stringify({
      type: 'assistant',
      sessionId: 's',
      uuid: 'a',
      timestamp: '2026-11-11T10:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'mcp__albedo__show_preview', input: { path: '/x.html', title: 'Proposed row' } }] },
    }),
    0,
  )[0]!;
  const result =
    resultText === null
      ? null
      : parseLine(
          JSON.stringify({
            type: 'user',
            sessionId: 's',
            uuid: 'u',
            timestamp: '2026-11-11T10:01:00.000Z',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: resultText, is_error: isError }] },
          }),
          1,
        )[0]!;
  return { use: { ...use, id: 1, taskId: 3 }, result: result ? { ...result, id: 2, taskId: 3 } : null };
}

const V2: Preview = {
  id: 2,
  taskId: 3,
  requestId: 'r-2',
  toolUseId: 'toolu_2',
  title: 'Proposed row',
  version: 2,
  html: '<p>v2</p>',
  question: null,
  note: null,
  createdAt: 1,
  outcome: 'changes',
  answer: 'changes requested on v2:\n1. Fill the Approve button.',
  answeredAt: 2,
};

describe('PreviewChip', () => {
  it('names the version and how it ended, and opens it read only', async () => {
    kept.byToolUse.set('toolu_2', V2);
    const { use, result } = rows('toolu_2', V2.answer);
    render(
      <>
        <PreviewChip message={use} result={result} />
        <PreviewViewerHost taskId={3} />
      </>,
    );
    const chip = await screen.findByRole('button', { name: /Preview: Proposed row, v2/ });
    // #356: the parts are separate, as on every tool row -- never run together.
    const parts = [...chip.children].map((el) => el.textContent?.trim()).filter(Boolean);
    expect(parts).toEqual(['Preview', 'Proposed row', 'v2', 'Open ↗', 'Changes requested · 1 comment']);
    expect(chip.closest('.tx-chip')).not.toBeNull();
    expect(chip.classList.contains('tx-chip-head')).toBe(true);
    act(() => fireEvent.click(chip));
    const viewer = screen.getByRole('dialog', { name: 'Preview: Proposed row, v2, read only' });
    expect(viewer.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(screen.getByText(/Fill the Approve button/)).toBeTruthy();
    // Read only: nothing in it answers.
    expect(screen.queryByRole('button', { name: /Approve|Send/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the question asked, or from v2 on what changed', async () => {
    kept.byToolUse.set('toolu_3', { ...V2, toolUseId: 'toolu_3', question: 'Does it read?', note: 'Smaller gap' });
    const { use, result } = rows('toolu_3', null);
    render(<PreviewChip message={use} result={result} />);
    expect(await screen.findByText('Smaller gap')).toBeTruthy();
    expect(screen.queryByText('Does it read?')).toBeNull();
  });

  it('closes the viewer on Esc pressed inside the page, and only from its own frame', async () => {
    kept.byToolUse.set('toolu_2', V2);
    const { use, result } = rows('toolu_2', V2.answer);
    render(
      <>
        <PreviewChip message={use} result={result} />
        <PreviewViewerHost taskId={3} />
      </>,
    );
    const chip = await screen.findByRole('button', { name: /Preview: Proposed row, v2/ });
    act(() => fireEvent.click(chip));
    const frame = screen.getByRole('dialog').querySelector('iframe')!;
    act(() => window.dispatchEvent(new MessageEvent('message', { data: { tag: 'albedo-preview-escape' }, source: window })));
    expect(screen.queryByRole('dialog')).not.toBeNull();
    act(() => window.dispatchEvent(new MessageEvent('message', { data: { tag: 'albedo-preview-escape' }, source: frame.contentWindow })));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('without a kept copy, reads how it ended from the result and opens nothing', async () => {
    const { use, result } = rows('toolu_9', "The user doesn't want to proceed with this tool use.", true);
    render(<PreviewChip message={use} result={result} />);
    expect(await screen.findByText('Cancelled')).toBeTruthy();
    expect(screen.getByText('No copy kept')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
