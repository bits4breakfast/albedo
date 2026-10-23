import { describe, expect, it, vi } from 'vitest';

const live = new Set<number>([1]);
vi.mock('./Terminal', () => ({ hasLivePty: (id: number) => live.has(id), ptyLiveSince: () => null, submitPty: vi.fn(async () => true) }));
vi.mock('./transcript/composerBridge', () => ({ insertIntoComposer: vi.fn(() => true) }));

const { canSubmitNow, sendPrompt } = await import('./sendPrompt');

describe('canSubmitNow', () => {
  it('hands a live session the prompt, also while it works: the gateway holds it for the turn', () => {
    expect(canSubmitNow({ id: 1, status: 'idle' })).toBe(true);
    expect(canSubmitNow({ id: 1, status: 'running' })).toBe(true);
  });

  it('holds back for a permission prompt, which typing would answer, and with no session', () => {
    expect(canSubmitNow({ id: 1, status: 'blocked' })).toBe(false);
    expect(canSubmitNow({ id: 2, status: 'idle' })).toBe(false);
  });

  it('leaves the prompt in the message box when it cannot submit', async () => {
    expect(await sendPrompt({ id: 1, status: 'running' }, 'x')).toBe('sent');
    expect(await sendPrompt({ id: 1, status: 'blocked' }, 'x')).toBe('composer');
  });
});
