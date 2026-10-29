/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import fixture from '../../capture/fixtures/local-command.jsonl?raw';
import { endsLocalCommand, isLocalCommandLine, parseTranscript } from '../../capture/adapter';
import type { Message } from '../../types';
import { MessageRow } from './MessageRow';
import { echoLanded } from './TranscriptPane';

afterEach(cleanup);

/**
 * `/rc` then `/rename tidy-retry`, as Claude Code 2.1.312 writes them: each a
 * `system/local_command` line for the command and one for its output (#113).
 */
const rows: Message[] = parseTranscript(fixture).map((r, i) => ({ ...r, id: i + 1, taskId: 1 }));
const local = rows.filter((r) => isLocalCommandLine(r.rawJson));
const [rcCommand, rcOutput, renameCommand, renameOutput] = local as [Message, Message, Message, Message];

describe('isLocalCommandLine', () => {
  it('is true for the command and its output, and for nothing else', () => {
    expect(local.map((r) => r.body?.slice(0, 22))).toEqual([
      '<command-name>/remote-',
      '<local-command-stdout>',
      '<command-name>/rename<',
      '<local-command-stdout>',
    ]);
    // Stored as `system` rows, raw line intact.
    expect(local.every((r) => r.role === 'system' && r.rawJson.includes('"subtype":"local_command"'))).toBe(true);
    // The prompt, the reply and the bridge status are not local commands.
    expect(rows.filter((r) => !isLocalCommandLine(r.rawJson)).map((r) => r.role)).toEqual(['user', 'assistant', 'system']);
    expect(isLocalCommandLine('not json')).toBe(false);
  });

  it('agrees with endsLocalCommand on system lines', () => {
    for (const r of rows.filter((x) => x.role === 'system')) {
      expect(endsLocalCommand(r.rawJson)).toBe(isLocalCommandLine(r.rawJson));
    }
  });
});

describe('a local slash command in the transcript', () => {
  it('reads as yours: "You" and the command, never the raw tags', () => {
    const { container } = render(<MessageRow message={rcCommand} />);
    expect(container.querySelector('.tx-row-user')).not.toBeNull();
    expect(container.querySelector('.tx-gutter')?.textContent).toBe('You');
    expect(container.querySelector('.tx-cmd-name')?.textContent).toBe('/remote-control');
    expect(container.querySelector('.tx-cmd-args')).toBeNull();
    expect(container.textContent).not.toContain('<command-name>');
    expect(container.textContent).not.toContain('Sys');
  });

  it('shows the arguments typed with it', () => {
    const { container } = render(<MessageRow message={renameCommand} />);
    expect(container.querySelector('.tx-cmd-name')?.textContent).toBe('/rename');
    expect(container.querySelector('.tx-cmd-args')?.textContent).toBe('tidy-retry');
  });

  it('draws nothing for empty output', () => {
    const { container } = render(<MessageRow message={rcOutput} />);
    expect(container.innerHTML).toBe('');
  });

  it("shows output as the terminal's, without the tags and without \"You\"", () => {
    const { container } = render(<MessageRow message={renameOutput} />);
    expect(container.querySelector('.tx-row-user')).toBeNull();
    expect(container.querySelector('.tx-gutter')?.textContent).toBe('');
    expect(container.querySelector('.tx-output')?.textContent).toBe('Session renamed to: tidy-retry');
    expect(container.textContent).not.toContain('local-command-stdout');
  });

  it('leaves other system rows as they were', () => {
    const status = rows.find((r) => r.role === 'system' && !isLocalCommandLine(r.rawJson)) as Message;
    const { container } = render(<MessageRow message={status} />);
    expect(container.querySelector('.tx-gutter')?.textContent).toBe('Sys');
  });
});

describe('echoLanded', () => {
  const at = rcCommand.ts - 200;
  const beforeSend = rows.filter((r) => r.ts < at - 1000);

  it('clears the echo of a local command when its row arrives', () => {
    expect(echoLanded({ at }, beforeSend)).toBe(false);
    expect(echoLanded({ at }, [...beforeSend, rcCommand])).toBe(true);
    // The output line alone is enough: both are written in the same instant.
    expect(echoLanded({ at }, [...beforeSend, rcOutput])).toBe(true);
  });

  it('still clears on a prompt, and ignores rows written before the send', () => {
    const prompt = rows[0] as Message;
    expect(echoLanded({ at: prompt.ts }, [prompt])).toBe(true);
    expect(echoLanded({ at: rcCommand.ts + 5000 }, [rcCommand, rcOutput])).toBe(false);
  });

  it("does not clear on another system row, or on a subagent's", () => {
    const status = rows.find((r) => r.role === 'system' && !isLocalCommandLine(r.rawJson)) as Message;
    expect(echoLanded({ at }, [...beforeSend, status])).toBe(false);
    expect(echoLanded({ at }, [{ ...rcCommand, agentId: 'a1' }])).toBe(false);
  });
});
