/**
 * @vitest-environment jsdom
 *
 * ⌥⌘↓ between the two that answer it (#398), both mounted as App mounts them:
 * the transcript on screen, and the editor's tab behind it with a file open.
 * The editor's Next Changed File listens on the window in the capture phase
 * and stays live while its tab is hidden; it must hand ⌥⌘↓ to the transcript
 * when the keyboard is free there, and keep it when focus is elsewhere.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { Message, Task } from '../../types';

vi.mock('../Terminal', () => ({
  notePty: vi.fn(),
  submitPty: vi.fn(async () => true),
  startPty: vi.fn(() => false),
  hasLivePty: vi.fn(() => true),
  ptyLiveSince: vi.fn(() => null),
  usePtyLiveSince: vi.fn(() => null),
  canResume: vi.fn(() => false),
  onPtyPresenceChange: vi.fn(() => () => {}),
}));
vi.mock('../BackgroundWork', () => ({ useBackgroundWork: () => [], backgroundShown: () => [] }));
vi.mock('./OverlayScrollbar', () => ({ default: () => null }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(async () => 'const a = 1;\n'),
  writeTextFile: vi.fn(async () => {}),
  exists: vi.fn(async () => true),
}));
vi.mock('../../lib/paths', () => ({
  resolveInWorktree: vi.fn(async (root: string, path: string) => ({ absolute: `${root}/${path}`, relative: path })),
}));
vi.mock('../../lib/highlight', () => ({
  highlightToTokens: vi.fn(async () => []),
  peekTokens: vi.fn(() => null),
  styleToCss: vi.fn(() => ''),
}));
vi.mock('../../lsp/phpantom', () => ({
  isPhpPath: () => false,
  warmPhpantom: vi.fn(),
  phpantomFailure: () => null,
  phpantomAvailability: () => null,
  subscribePhpantom: () => () => {},
  dismissPhpantomFailure: vi.fn(),
}));
vi.mock('../../db/comments', async () => ({
  ...(await vi.importActual<typeof import('../../db/comments')>('../../db/comments')),
  listComments: vi.fn(async () => []),
  onCommentsChanged: vi.fn(() => () => {}),
}));
const db: Message[] = [];
vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  getMessages: vi.fn(async () => db.map((m) => ({ ...m }))),
}));
vi.mock('../../capture', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../capture')>()),
  onCaptureUpdate: () => () => {},
}));

// jsdom has no layout; CodeMirror measures selections with these.
Object.assign(Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new DOMRect() });

const { TranscriptPane } = await import('./TranscriptPane');
const { default: FileEditor } = await import('../editor/FileEditor');
const { setTouchedOrder } = await import('../touchedOrder');

const task: Task = {
  id: 1, title: 't', projectId: 1, repoPath: '/repo', baseBranch: 'main', branch: 'b',
  worktreePath: '/wt', sessionId: 's1', ownsWorktree: true, createdBranch: true, kind: 'work',
  status: 'idle', createdAt: 0, lastActivityAt: null, seenAt: null, summary: null,
  reviewUrl: null, apiError: null, apiErrorText: null, spunFromTaskId: null,
};

beforeEach(() => {
  db.length = 0;
  for (let id = 1; id <= 10; id++) {
    db.push({
      id, taskId: 1, sessionId: 's1', seq: id * 100, role: 'assistant', toolName: null, targetPath: null,
      body: `row ${id}`, rawJson: JSON.stringify({ type: 'assistant', i: id }), agentId: null, ts: 1_700_000_000_000 + id * 1000,
    });
  }
  const data = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

const JUMP = { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, altKey: true, bubbles: true, cancelable: true };

/** The Transcript tab on screen, read above the end; the Editor tab hidden with a.ts open. */
async function mountBoth() {
  setTouchedOrder(task.id, ['src/a.ts', 'src/b.ts']);
  const onStep = vi.fn();
  const slot = document.body.appendChild(document.createElement('div'));
  render(
    <div>
      <div className="tabpanel">
        <TranscriptPane taskId={1} sessionId="s1" />
      </div>
      <div className="tabpanel" hidden>
        <FileEditor task={task} request={{ path: 'src/a.ts' }} onClose={() => {}} controlsSlot={slot} onStep={onStep} />
      </div>
      <textarea aria-label="elsewhere" />
    </div>,
  );
  await waitFor(() => {
    if (document.querySelectorAll('.tx-scroll [data-message-id]').length !== 10) throw new Error('transcript not drawn');
    if (!document.querySelector('.cm-content')) throw new Error('editor not mounted yet');
  });
  const scroller = document.querySelector<HTMLElement>('.tx-scroll')!;
  // jsdom has no layout: the transcript's tab is the one on screen.
  Object.defineProperty(scroller, 'offsetParent', { configurable: true, get: () => document.body });
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 1000 });
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 300 });
  scroller.scrollTop = 100;
  fireEvent.scroll(scroller);
  return { onStep, scroller };
}

function press(target: EventTarget) {
  const e = new KeyboardEvent('keydown', JUMP);
  act(() => void target.dispatchEvent(e));
  return e;
}

describe('⌥⌘↓ with the transcript on screen and a file open behind it (#398)', () => {
  it('jumps the transcript to the latest message, and the hidden editor stays on its file', async () => {
    const { onStep, scroller } = await mountBoth();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(press(document.body).defaultPrevented).toBe(true);
    expect(scroller.scrollTop).toBe(1000);
    expect(onStep).not.toHaveBeenCalled();
  });

  it('with focus in a field outside the transcript, leaves it to the editor, as before', async () => {
    const { onStep, scroller } = await mountBoth();
    const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="elsewhere"]')!;
    field.focus();
    press(field);
    expect(onStep.mock.calls.map((c) => c[0])).toEqual(['src/b.ts']);
    expect(scroller.scrollTop).toBe(100);
  });
});
