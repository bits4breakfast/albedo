/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { Message } from '../../types';
import { MessageRow } from './MessageRow';

afterEach(cleanup);

const thinking = (body: string | null): Message => ({
  id: 1,
  taskId: 1,
  sessionId: 's',
  seq: 200,
  role: 'assistant',
  toolName: 'thinking',
  targetPath: null,
  body,
  // The shape Claude Code now writes: no text, only a signature.
  rawJson: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '', signature: 'x' }] } }),
  agentId: null,
  ts: 0,
});

describe('thinking rows', () => {
  it('renders nothing for a block whose text was not recorded, rather than a caret onto nothing', () => {
    for (const body of ['', '   \n', null]) {
      const { container } = render(<MessageRow message={thinking(body)} />);
      expect(container.innerHTML).toBe('');
      expect(screen.queryByRole('button')).toBeNull();
      cleanup();
    }
  });

  it('folds a recorded block behind a caret that opens onto its text', () => {
    render(<MessageRow message={thinking('The uploader has no backoff.')} />);
    const head = screen.getByRole('button');
    expect(head.textContent).toContain('Thinking · 5 Words');
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('The uploader has no backoff.')).toBeNull();
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('The uploader has no backoff.')).toBeTruthy();
  });
});
