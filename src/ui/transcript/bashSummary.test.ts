import { describe, expect, it } from 'vitest';
import type { Message } from '../../types';
import { summaryOf, withoutLeadingCd } from './ToolChip';

const bash = (command: string, targetPath: string | null): Message =>
  ({
    id: 1,
    taskId: 1,
    sessionId: 's',
    seq: 0,
    role: 'tool_use',
    toolName: 'Bash',
    targetPath,
    body: JSON.stringify({ command }),
    rawJson: JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } }),
    agentId: null,
    ts: 0,
  }) as unknown as Message;

describe('withoutLeadingCd (#117)', () => {
  const dir = '/private/tmp/scratch/work';

  it('drops a leading cd to the folder the chip already names', () => {
    expect(withoutLeadingCd(`cd ${dir} && git add -A && git commit -q --amend`, dir)).toBe('git add -A && git commit -q --amend');
    expect(withoutLeadingCd(`  cd ${dir}; npm test`, dir)).toBe('npm test');
  });

  it('keeps a cd to any other folder, a bare cd, and a command with no target', () => {
    expect(withoutLeadingCd('cd /elsewhere && ls', dir)).toBe('cd /elsewhere && ls');
    expect(withoutLeadingCd(`cd ${dir}`, dir)).toBe(`cd ${dir}`);
    expect(withoutLeadingCd(`cd ${dir} && `, dir)).toBe(`cd ${dir} && `);
    expect(withoutLeadingCd(`cd ${dir} && ls`, null)).toBe(`cd ${dir} && ls`);
    expect(withoutLeadingCd(`echo cd ${dir} && ls`, dir)).toBe(`echo cd ${dir} && ls`);
  });
});

describe('summaryOf / Bash', () => {
  it('reads what the command does, after the folder the chip names', () => {
    const m = bash('cd /tmp/work && git status', '/tmp/work');
    expect(summaryOf(m)).toBe('git status');
  });
});
