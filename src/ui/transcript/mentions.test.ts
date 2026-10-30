import { describe, expect, it } from 'vitest';
import type { Project } from '../../types';
import { task } from './mentions.fixture';
import { encodeInlineMarker, findMarker, splitMarkers } from './albedoMarkers';
import { parseUserBody } from './envelopes';
import {
  bareFileMentions,
  encodeMention,
  fileMention,
  inlineMentions,
  intactMentions,
  markMentions,
  mentionTrigger,
  rankPaths,
  rankTasks,
  taskMention,
  taskToken,
  transcriptPathFor,
  unmarkMentions,
  type Mention,
} from './mentions';
import { foldPastes, markPastes, queuedLabel } from './pastedText';

const projects = [
  { id: 1, name: 'App' },
  { id: 2, name: 'Site' },
] as unknown as Project[];

describe('the @ trigger', () => {
  it('opens on @ at the start, or after whitespace, with what follows up to the caret', () => {
    expect(mentionTrigger('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionTrigger('ask @fix', 8)).toEqual({ start: 4, query: 'fix' });
    expect(mentionTrigger('line\n@src/a', 11)).toEqual({ start: 5, query: 'src/a' });
  });

  it('not inside a word (an email), not past a space, not on a picked task token', () => {
    expect(mentionTrigger('me@example.com', 14)).toBeNull();
    expect(mentionTrigger('ask @fix it', 11)).toBeNull();
    expect(mentionTrigger('@[Fix login]', 5)).toBeNull();
    expect(mentionTrigger('no at here', 5)).toBeNull();
  });

  it('follows the caret, not the end of the text', () => {
    expect(mentionTrigger('@fi and more', 3)).toEqual({ start: 0, query: 'fi' });
  });
});

describe('the list: tasks', () => {
  const current = { id: 1, projectId: 1 };
  it('excludes the current task, archived ones, and ones without a session', () => {
    const tasks = [
      task(1, 'This one'),
      task(2, 'Archived', { status: 'archived' }),
      task(3, 'Never started', { sessionId: null }),
      task(4, 'Fix login retry'),
    ];
    expect(rankTasks(tasks, projects, current, '').map((t) => t.task.id)).toEqual([4]);
  });

  it('puts this project first, then the others, most recently active first with no query', () => {
    const tasks = [task(2, 'Other project', { projectId: 2, lastActivityAt: 9999 }), task(3, 'Older'), task(4, 'Newer')];
    const rows = rankTasks(tasks, projects, current, '');
    expect(rows.map((t) => t.task.id)).toEqual([4, 3, 2]);
    expect(rows[2]?.projectName).toBe('Site');
  });

  it('filters fuzzily on the title, and on the branch', () => {
    const tasks = [task(2, 'Fix login retry'), task(3, 'Docs pass', { branch: 'feature/login-docs' }), task(4, 'Unrelated')];
    expect(rankTasks(tasks, projects, current, 'fixlog').map((t) => t.task.id)).toEqual([2]);
    const login = rankTasks(tasks, projects, current, 'login');
    expect(login.map((t) => t.task.id)).toEqual([2, 3]); // title beats branch
    expect(login[0]?.hits.length).toBe(5);
    expect(rankTasks(tasks, projects, current, 'zzz')).toEqual([]);
  });
});

describe('the list: files and folders', () => {
  const files = ['src/ui/App.tsx', 'src/ui/transcript/Composer.tsx', 'README.md', 'src/lib/fuzzy.ts'];
  it('lists nothing until something is typed', () => {
    expect(rankPaths(files, '')).toEqual([]);
  });

  it('ranks like Go to File, and offers the folders files are in', () => {
    const rows = rankPaths(files, 'compo');
    expect(rows[0]).toMatchObject({ kind: 'file', path: 'src/ui/transcript/Composer.tsx', name: 'Composer.tsx', dir: 'src/ui/transcript' });
    const folders = rankPaths(files, 'transcript');
    expect(folders.some((r) => r.kind === 'folder' && r.path === 'src/ui/transcript/' && r.name === 'transcript/')).toBe(true);
  });
});

describe('tokens in the draft', () => {
  const fix = taskMention(task(2, 'Fix login retry'));
  const foo = fileMention('src/foo.ts');

  it('a task token is its title in brackets; a second task of that title gets its project, then a number', () => {
    const taken = new Set<string>();
    const t1 = taskToken('Fix login', 'App', (t) => taken.has(t));
    taken.add(t1);
    const t2 = taskToken('Fix login', 'Site', (t) => taken.has(t));
    taken.add(t2);
    const t3 = taskToken('Fix login', 'Site', (t) => taken.has(t));
    expect([t1, t2, t3]).toEqual(['@[Fix login]', '@[Fix login · Site]', '@[Fix login (2)]']);
  });

  it('a token counts only while intact and standing on its own', () => {
    const store = new Map<string, Mention>([
      ['@[Fix login retry]', fix],
      ['@src/foo.ts', foo],
    ]);
    const found = (draft: string) => intactMentions(draft, store).map((t) => t.token);
    expect(found('ask @[Fix login retry] about @src/foo.ts.')).toEqual(['@[Fix login retry]', '@src/foo.ts']);
    expect(found('ask @[Fix login retr] now')).toEqual([]); // edited
    expect(found('x@src/foo.ts')).toEqual([]); // glued to a word
    expect(found('@src/foo.tsx')).toEqual([]); // another file
    expect(found('(@src/foo.ts)')).toEqual(['@src/foo.ts']);
  });

  it('on send, intact tokens become markers and everything else is sent as typed', () => {
    const store = new Map<string, Mention>([
      ['@[Fix login retry]', fix],
      ['@src/foo.ts', foo],
    ]);
    const body = markMentions('ask @[Fix login retry] about @src/foo.ts and @src/bar.ts', store);
    expect(body).toBe(`ask ${encodeMention(fix)} about ${encodeMention(foo)} and @src/bar.ts`);
    expect(markMentions('@[Fix login retr]', store)).toBe('@[Fix login retr]');
  });
});

describe('the markers', () => {
  it('a file reference keeps whitespace on both sides of @path, so Claude Code still attaches it', () => {
    expect(encodeMention(fileMention('src/foo.ts'))).toBe('<file-ref path="src/foo.ts"> @src/foo.ts </file-ref>');
    expect(encodeMention(fileMention('docs/my notes.md'))).toBe('<file-ref path="docs/my notes.md"> @"docs/my notes.md" </file-ref>');
  });

  it('a task reference carries what SendMessage and a reader need', () => {
    const m = taskMention(task(2, 'Fix "login" <retry>'));
    const enc = encodeMention(m);
    expect(enc).toBe(
      '<task-ref session="Fix &quot;login&quot; &lt;retry&gt;" session-id="00000002-aaaa-bbbb-cccc-dddddddddddd"' +
        ' task="Fix &quot;login&quot; &lt;retry&gt;" task-id="2" worktree="/code/app-wt/2"' +
        ' transcript="~/.claude/projects/-code-app-wt-2/00000002-aaaa-bbbb-cccc-dddddddddddd.jsonl">@Fix "login" retry</task-ref>',
    );
    const found = findMarker(`ask ${enc} now`);
    expect(found?.attrs.task).toBe('Fix "login" <retry>');
    expect(found?.content).toBe('@Fix "login" retry');
  });

  it('the transcript path is Claude Code’s folder name for the worktree, or nothing past 200 characters', () => {
    expect(transcriptPathFor('/private/tmp/a_b.c/', 'S')).toBe('~/.claude/projects/-private-tmp-a-b-c/S.jsonl');
    expect(transcriptPathFor(`/${'x'.repeat(220)}`, 'S')).toBeNull();
  });

  it('a sent body comes back to the box as tokens, the same task once', () => {
    const fix = taskMention(task(2, 'Fix login retry'));
    const body = `ask ${encodeMention(fix)} and ${encodeMention(fix)} about ${encodeMention(fileMention('src/a.ts'))}`;
    const back = unmarkMentions(body);
    expect(back.text).toBe('ask @[Fix login retry] and @[Fix login retry] about @src/a.ts');
    expect([...back.mentions.keys()]).toEqual(['@[Fix login retry]', '@src/a.ts']);
    expect(markMentions(back.text, back.mentions)).toBe(body);
  });

  it('pastes and references in one message: each its own marker, and neither breaks the other', () => {
    const store = new Map<string, Mention>([['@src/a.ts', fileMention('src/a.ts')]]);
    const pastes = new Map([[1, 'log line @src/a.ts\nb\nc\nd']]);
    const body = markPastes(markMentions('see @src/a.ts and [Pasted text #1 +4 lines]', store), pastes);
    // The paste's own text is never read for tokens.
    expect(body).toContain('<pasted-text id="1" lines="4">\nlog line @src/a.ts\nb\nc\nd\n</pasted-text id="1">');
    expect(splitMarkers(body).filter((p) => p.kind === 'marker')).toHaveLength(2);
  });
});

describe('the echo and the Queued band', () => {
  const fix = taskMention(task(2, 'Fix login retry'));
  const body = `ask ${encodeMention(fix)} about ${encodeMention(fileMention('src/a.ts'))}`;
  it('show a reference by its label', () => {
    expect(foldPastes(body)).toBe('ask @Fix login retry about @src/a.ts');
    expect(queuedLabel(body)).toBe('ask @Fix login retry about @src/a.ts');
  });

  it('also inside Claude Code’s paste wrapper', () => {
    expect(queuedLabel(`<pasted_content id="5c98">\n${body}\n</pasted_content id="5c98">`)).toBe('ask @Fix login retry about @src/a.ts');
  });
});

describe('the transcript', () => {
  const fix = taskMention(task(2, 'Fix login retry'));
  const body = `ask ${encodeMention(fix)} about ${encodeMention(fileMention('src/a.ts'))} please`;

  it('keeps a reference in the sentence, as its label, and lists it', () => {
    const blocks = parseUserBody(body);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'text', text: 'ask @Fix login retry about @src/a.ts please' });
    const mentions = blocks[0]?.kind === 'text' ? blocks[0].mentions : [];
    expect(mentions?.map((m) => m.label)).toEqual(['@Fix login retry', '@src/a.ts']);
    expect(mentions?.[0]).toMatchObject({ kind: 'task', taskId: 2, sessionId: fix.sessionId });
  });

  it('the same inside Claude Code’s paste wrapper, beside a paste', () => {
    const wrapped = `<pasted_content id="ab12">\n${body}\n<pasted-text id="1" lines="1">\nx\n</pasted-text id="1">\n</pasted_content id="ab12">`;
    const blocks = parseUserBody(wrapped);
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'pasted']);
    expect(blocks[0]).toMatchObject({ text: 'ask @Fix login retry about @src/a.ts please' });
  });

  it('a message of references only, wrapped, is still yours', () => {
    const blocks = parseUserBody(`<pasted_content id="ab12">\n${encodeMention(fix)}\n</pasted_content id="ab12">`);
    expect(blocks).toEqual([{ kind: 'text', text: '@Fix login retry', mentions: [fix] }]);
  });

  it('a title holding XML characters survives the wrapper unescape', () => {
    const odd = taskMention(task(3, 'Use <b> & "quotes"'));
    const blocks = parseUserBody(`<pasted_content id="ab12">\nsee ${encodeMention(odd)}\n</pasted_content id="ab12">`);
    expect(blocks[0]).toMatchObject({ kind: 'text', text: 'see @Use <b> & "quotes"' });
  });

  it('recognises a bare @path the person typed, as Claude Code attached it', () => {
    expect(bareFileMentions('look at @src/foo.ts, and @README.md.').map((m) => m.path)).toEqual(['src/foo.ts', 'README.md']);
    expect(bareFileMentions('@"docs/my notes.md" too').map((m) => m.path)).toEqual(['docs/my notes.md']);
    // Not paths: a word, an email, an MCP resource, a typed task token.
    expect(bareFileMentions('@here me@x.com @server:res @[Fix]')).toEqual([]);
    const blocks = parseUserBody('fix @src/foo.ts please');
    expect(blocks[0]).toMatchObject({ kind: 'text', mentions: [{ kind: 'file', path: 'src/foo.ts' }] });
  });

  it('leaves a malformed marker as text', () => {
    const broken = '<task-ref task="x">@x';
    expect(inlineMentions(broken).text).toBe(broken);
    expect(encodeInlineMarker('file-ref', { path: 'a' }, ' @a ')).toBe('<file-ref path="a"> @a </file-ref>');
  });
});

describe('a draft with references', () => {
  it('keeps the references its tokens still use, and reads older drafts without any', async () => {
    const { draftsCodec } = await import('./drafts');
    const foo = fileMention('src/foo.ts');
    const draft = { text: 'see @src/foo.ts', pastes: [], mentions: [['@src/foo.ts', foo]], savedAt: 1 };
    const decoded = draftsCodec.decode(JSON.stringify({ 1: draft, 2: { text: 'old', pastes: [], savedAt: 1 } }));
    expect(decoded?.get(1)?.mentions).toEqual([['@src/foo.ts', foo]]);
    expect(decoded?.get(2)?.mentions).toBeUndefined();
    // A malformed reference list drops that draft, not every draft.
    const bad = draftsCodec.decode(JSON.stringify({ 1: { ...draft, mentions: [['x', null]] }, 2: { text: 'ok', pastes: [], savedAt: 1 } }));
    expect([...(bad?.keys() ?? [])]).toEqual([2]);
  });
});
