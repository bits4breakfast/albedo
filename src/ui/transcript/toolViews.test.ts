import { describe, expect, it } from 'vitest';
import { formatShellCommand, inputViewFor, parseQuestionAnswers, type InputView } from './toolViews';

const view = <K extends InputView['kind']>(v: InputView, kind: K) => {
  expect(v.kind).toBe(kind);
  return v as Extract<InputView, { kind: K }>;
};

describe('formatShellCommand', () => {
  it('leaves a short command alone', () => {
    expect(formatShellCommand('git status')).toBe('git status');
    expect(formatShellCommand('npm run build && npm test')).toBe('npm run build && npm test');
  });

  it('leaves a command the author already formatted alone', () => {
    const heredoc = "cat <<'EOF' > x.txt\nline one && line two\nEOF";
    expect(formatShellCommand(heredoc)).toBe(heredoc);
  });

  it('breaks a long && chain after each operator', () => {
    // The shape from the user's screenshot.
    const cmd =
      'echo "=== branch state ===" && git status --porcelain && echo "(clean)" && git log --oneline -1 && echo "done"';
    expect(formatShellCommand(cmd).split('\n')).toEqual([
      'echo "=== branch state ===" &&',
      'git status --porcelain &&',
      'echo "(clean)" &&',
      'git log --oneline -1 &&',
      'echo "done"',
    ]);
  });

  it('produces a command that is still valid shell and still means the same thing', () => {
    const cmd = 'a'.repeat(50) + ' && ' + 'b'.repeat(50) + ' ; ' + 'c'.repeat(20);
    const out = formatShellCommand(cmd);
    // Every break sits AFTER a continuation operator, never before it.
    for (const line of out.split('\n').slice(0, -1)) {
      expect(line).toMatch(/(&&|\|\||;)$/);
    }
    // Rejoining reproduces the original modulo the whitespace we normalised.
    expect(out.replace(/\s+/g, ' ')).toBe(cmd.replace(/\s+/g, ' '));
  });

  it('does NOT break on an operator inside double quotes', () => {
    const cmd = `echo "this is a long string with && inside it that must not split" && ${'x'.repeat(60)}`;
    const lines = formatShellCommand(cmd).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('echo "this is a long string with && inside it that must not split" &&');
  });

  it('does NOT break on an operator inside single quotes or backticks', () => {
    const single = `echo 'a && b ; c' && ${'y'.repeat(80)}`;
    expect(formatShellCommand(single).split('\n')[0]).toBe("echo 'a && b ; c' &&");
    const tick = 'echo `a && b` && ' + 'z'.repeat(80);
    expect(formatShellCommand(tick).split('\n')[0]).toBe('echo `a && b` &&');
  });

  it('respects backslash escapes outside quotes', () => {
    const cmd = `printf a\\&\\&b && ${'q'.repeat(90)}`;
    const lines = formatShellCommand(cmd).split('\n');
    expect(lines[0]).toBe('printf a\\&\\&b &&');
  });

  it('does not break bare pipes', () => {
    const cmd = `ps aux | grep something | awk '{print $2}' | head -20 | sort | uniq -c | tail -5 | cat -n`;
    expect(formatShellCommand(cmd)).not.toContain('\n');
  });

  it('breaks on ; but not on ;; (case statements)', () => {
    const cmd = `alpha ${'a'.repeat(80)} ; beta ; gamma`;
    expect(formatShellCommand(cmd).split('\n')).toHaveLength(3);
    const caseCmd = `case $x in a) foo ;; b) bar ;; esac ${'#'.repeat(70)}`;
    expect(formatShellCommand(caseCmd)).not.toContain('\n');
  });

  it('never throws and handles degenerate input', () => {
    for (const s of ['', '&&', '   ', '"unterminated ' + 'x'.repeat(90), "'" + 'y'.repeat(95)]) {
      expect(() => formatShellCommand(s)).not.toThrow();
    }
    expect(formatShellCommand('')).toBe('');
  });

  it('leaves no trailing blank line when the command ends in an operator', () => {
    const cmd = `${'a'.repeat(90)} && `;
    expect(formatShellCommand(cmd).endsWith('\n')).toBe(false);
  });
});

describe('inputViewFor', () => {
  it('renders Bash as shell, with the description kept out of the code', () => {
    const v = view(inputViewFor('Bash', { command: 'git status', description: 'Check state' }), 'shell');
    expect(v.command).toBe('git status');
    expect(v.description).toBe('Check state');
  });

  it('surfaces Bash timeout and background as quiet fields', () => {
    const v = view(inputViewFor('Bash', { command: 'sleep 1', timeout: 5000, run_in_background: true }), 'shell');
    expect(v.fields).toEqual([
      { label: 'Timeout', value: '5000 ms' },
      { label: 'Background', value: 'yes' },
    ]);
  });

  it('falls back to JSON when Bash has no command', () => {
    expect(inputViewFor('Bash', { description: 'oops' }).kind).toBe('json');
  });

  it('renders Read as file plus a human line range', () => {
    const v = view(inputViewFor('Read', { file_path: '/a/b.ts', offset: 120, limit: 40 }), 'fields');
    expect(v.fields).toEqual([
      { label: 'File', value: '/a/b.ts', path: true },
      { label: 'Lines', value: '120–160' },
    ]);
  });

  it('phrases partial Read ranges the way a person would', () => {
    expect(view(inputViewFor('Read', { file_path: '/a', offset: 9 }), 'fields').fields[1]?.value).toBe('from 9');
    expect(view(inputViewFor('Read', { file_path: '/a', limit: 40 }), 'fields').fields[1]?.value).toBe('first 40');
    expect(view(inputViewFor('Read', { file_path: '/a' }), 'fields').fields).toHaveLength(1);
  });

  it('renders Grep as pattern plus scope', () => {
    const v = view(
      inputViewFor('Grep', { pattern: 'retry', path: 'src', glob: '*.ts', output_mode: 'content', '-i': true }),
      'fields',
    );
    expect(v.fields).toEqual([
      { label: 'Pattern', value: 'retry' },
      { label: 'In', value: 'src', path: true },
      { label: 'Files', value: '*.ts' },
      { label: 'Mode', value: 'content' },
      { label: 'Ignore Case', value: 'yes' },
    ]);
  });

  it('renders Glob, and omits an absent path', () => {
    const v = view(inputViewFor('Glob', { pattern: '**/*.rs' }), 'fields');
    expect(v.fields).toEqual([{ label: 'Pattern', value: '**/*.rs' }]);
  });

  it('renders Write as the file content in the file grammar', () => {
    const v = view(inputViewFor('Write', { file_path: 'src/a.py', content: 'x = 1\n' }), 'file');
    expect(v.path).toBe('src/a.py');
    expect(v.lang).toBe('python');
    expect(v.content).toBe('x = 1\n');
  });

  it('keeps an empty Write body rather than falling back', () => {
    expect(inputViewFor('Write', { file_path: 'a.txt', content: '' }).kind).toBe('file');
  });

  it('falls back to JSON for unknown tools and for diff tools', () => {
    expect(inputViewFor('WebFetch', { url: 'https://x' }).kind).toBe('json');
    expect(inputViewFor('Edit', { file_path: 'a', old_string: 'x', new_string: 'y' }).kind).toBe('json');
    expect(inputViewFor('MultiEdit', { edits: [] }).kind).toBe('json');
    expect(inputViewFor(null, {}).kind).toBe('json');
    expect(inputViewFor('Bash', {}).kind).toBe('json');
  });
});

describe('AskUserQuestion', () => {
  const input = {
    questions: [
      {
        question: 'How should I handle it?',
        header: 'Toolchain',
        multiSelect: false,
        options: [
          { label: 'Install rustup now (Recommended)', description: 'Takes a minute.' },
          { label: 'Skip', description: 'Leave it.', preview: 'no changes' },
        ],
      },
    ],
  };

  it('reads the questions, options and previews', () => {
    const v = view(inputViewFor('AskUserQuestion', input), 'questions');
    expect(v.questions).toHaveLength(1);
    expect(v.questions[0]).toMatchObject({ header: 'Toolchain', multiSelect: false });
    expect(v.questions[0]?.options.map((o) => o.label)).toEqual(['Install rustup now (Recommended)', 'Skip']);
    expect(v.questions[0]?.options[1]?.preview).toBe('no changes');
    expect(v.questions[0]?.options[0]?.preview).toBeNull();
  });

  it('falls back to JSON when the shape is not what we expect', () => {
    expect(inputViewFor('AskUserQuestion', {}).kind).toBe('json');
    expect(inputViewFor('AskUserQuestion', { questions: 'nope' }).kind).toBe('json');
    expect(inputViewFor('AskUserQuestion', { questions: [{ header: 'no question text' }] }).kind).toBe('json');
  });

  it('pairs each answer back to its question', () => {
    const answers = parseQuestionAnswers(
      'Your questions have been answered: "How should I handle it?"="Install rustup now (Recommended)". ' +
        'You can now continue with these answers in mind.',
    );
    expect(answers.get('How should I handle it?')).toBe('Install rustup now (Recommended)');
  });

  it('keeps an answer that contains a comma', () => {
    // Splitting the result on ", " would cut this answer in half.
    const answers = parseQuestionAnswers(
      'Your questions have been answered: "What scope?"="Single hotel_id (Recommended)", ' +
        '"Report what?"="Commission only, via CommissionCalculatorService". You can now continue.',
    );
    expect(answers.size).toBe(2);
    expect(answers.get('Report what?')).toBe('Commission only, via CommissionCalculatorService');
  });

  it('ignores the trailing preview echo and anything unparseable', () => {
    const answers = parseQuestionAnswers('"Approve?"="Approve" selected preview:\nSCOPE: backend only');
    expect([...answers]).toEqual([['Approve?', 'Approve']]);
    expect(parseQuestionAnswers('').size).toBe(0);
    expect(parseQuestionAnswers('no result yet').size).toBe(0);
  });
});
