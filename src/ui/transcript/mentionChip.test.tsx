/**
 * @vitest-environment jsdom
 *
 * References in your message, drawn as chips (#154): a task goes to the task,
 * a file opens. Drawn from the rendered row, the way a person meets them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { Message } from '../../types';
import { FileOpenContext } from '../editor/openFile';
import { TaskOpenContext } from '../openTask';
import { MessageRow } from './MessageRow';
import { encodeMention, fileMention, taskMention } from './mentions';
import { task } from './mentions.fixture';

vi.mock('../../capture/peers', () => ({ senderTaskOf: async () => null }));

afterEach(cleanup);

const user = (body: string): Message => ({
  id: 1,
  taskId: 1,
  sessionId: 's',
  seq: 100,
  role: 'user',
  toolName: null,
  targetPath: null,
  body,
  rawJson: JSON.stringify({ type: 'user', message: { role: 'user', content: body } }),
  agentId: null,
  ts: 0,
});

const fix = taskMention(task(27, 'Fix login retry'));

function renderRow(body: string, has: (id: number) => boolean = (id) => id === 27) {
  const openTask = vi.fn();
  const openFile = vi.fn();
  const utils = render(
    <FileOpenContext.Provider value={openFile}>
      <TaskOpenContext.Provider value={{ has, open: openTask }}>
        <MessageRow message={user(body)} />
      </TaskOpenContext.Provider>
    </FileOpenContext.Provider>,
  );
  return { ...utils, openTask, openFile };
}

describe('a reference in your message', () => {
  it('a task is a chip that goes to the task, inside your sentence, with no tags shown', () => {
    const { container, openTask } = renderRow(`ask ${encodeMention(fix)} what it changed`);
    expect(container.querySelector('.tx-row-user')).not.toBeNull();
    expect(container.textContent).toContain('ask @Fix login retry what it changed');
    expect(container.textContent).not.toContain('task-ref');
    const chip = screen.getByRole('button', { name: '@Fix login retry' });
    expect(chip.closest('p')?.textContent).toBe('ask @Fix login retry what it changed');
    fireEvent.click(chip);
    expect(openTask).toHaveBeenCalledWith(27);
  });

  it('a task no longer open is shown, but is not a link', () => {
    const { container } = renderRow(`see ${encodeMention(fix)}`, () => false);
    expect(screen.queryByRole('button', { name: '@Fix login retry' })).toBeNull();
    expect(container.querySelector('span.tx-mention')?.textContent).toBe('@Fix login retry');
  });

  it('a file is a chip that opens it', () => {
    const { openFile } = renderRow(`read ${encodeMention(fileMention('src/foo.ts'))} first`);
    fireEvent.click(screen.getByRole('button', { name: '@src/foo.ts' }));
    expect(openFile).toHaveBeenCalledWith({ path: 'src/foo.ts', line: null }, { activated: true });
  });

  it('a bare @path you typed is one too; a bare name is looked up', () => {
    const { openFile } = renderRow('compare @src/a.ts with @Foo.php please');
    fireEvent.click(screen.getByRole('button', { name: '@src/a.ts' }));
    fireEvent.click(screen.getByRole('button', { name: '@Foo.php' }));
    expect(openFile).toHaveBeenNthCalledWith(1, { path: 'src/a.ts', line: null }, { activated: true });
    expect(openFile).toHaveBeenNthCalledWith(2, { path: 'Foo.php', line: null }, { lookup: true, activated: true });
  });

  it('a folder is shown, not a link; code is left alone', () => {
    const { container } = renderRow(`list ${encodeMention(fileMention('src/ui/'))} and \`@src/a.ts\``);
    expect(container.querySelector('span.tx-mention')?.textContent).toBe('@src/ui/');
    // The code span stays a code span (whatever link it already is), not a chip.
    expect(container.querySelectorAll('.tx-mention')).toHaveLength(1);
    expect(container.querySelector('.tx-md-code')?.textContent).toBe('@src/a.ts');
  });

  it('inside Claude Code’s paste wrapper too', () => {
    renderRow(`<pasted_content id="ab12">\nask ${encodeMention(fix)}\n</pasted_content id="ab12">`);
    expect(screen.getByRole('button', { name: '@Fix login retry' })).toBeTruthy();
  });
});
