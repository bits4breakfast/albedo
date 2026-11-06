// One task's made-up work, told once: every step changes the worktree's files
// AND adds the transcript lines Claude Code would have written for it, so the
// Files panel and the transcript can never tell different stories.

import { session } from './transcript.mjs';

/** Stands for a commit's short hash until git has made the commit. */
export const commitToken = (branch, i) => `@@COMMIT:${branch}:${i}@@`;

export function workspace({ files, sessionId, cwd, branch, startAt }) {
  const state = {
    files: new Map(Object.entries(files)),
    commits: [],
    /** Paths changed since the last commit. */
    dirty: new Set(),
  };
  let s = session({ sessionId, cwd, branch, startAt });
  const history = s;
  let live = null;
  /** The waiting card's two outcomes, when the live part ends on one. */
  let outcomes = null;

  const abs = (p) => `${cwd}/${p}`;
  const content = (p) => {
    const c = state.files.get(p);
    if (c === undefined || c === null) throw new Error(`demo scenario: ${p} does not exist on ${branch}`);
    return c;
  };

  const w = {
    prompt(text) {
      s.user(text);
      s.wait(4000);
      return w;
    },
    say(text) {
      s.say(text);
      s.wait(1500);
      return w;
    },
    read(path) {
      const text = content(path)
        .split('\n')
        .map((l, i) => `${String(i + 1).padStart(6)}\t${l}`)
        .join('\n');
      s.tool('Read', { file_path: abs(path) }, text, { took: 300 });
      s.wait(2500);
      return w;
    },
    grep(pattern, output) {
      s.tool('Grep', { pattern, path: cwd, output_mode: 'files_with_matches' }, output, { took: 400 });
      s.wait(2000);
      return w;
    },
    edit(path, oldString, newString) {
      const before = content(path);
      if (!before.includes(oldString)) throw new Error(`demo scenario: edit to ${path} does not match the file`);
      state.files.set(path, before.replace(oldString, newString));
      state.dirty.add(path);
      s.tool(
        'Edit',
        { file_path: abs(path), old_string: oldString, new_string: newString, replace_all: false },
        `The file ${abs(path)} has been updated successfully.`,
        { took: 600 },
      );
      s.wait(5000);
      return w;
    },
    write(path, text) {
      state.files.set(path, text);
      state.dirty.add(path);
      s.tool('Write', { file_path: abs(path), content: text }, `File created successfully at: ${abs(path)}`, { took: 500 });
      s.wait(6000);
      return w;
    },
    run(command, description, output, opts = {}) {
      s.tool('Bash', { command, description }, output, { took: opts.took ?? 4000 });
      s.wait(3000);
      return w;
    },
    commit(message) {
      const i = state.commits.length;
      const changed = [...state.dirty].sort();
      state.commits.push({ message, files: Object.fromEntries(changed.map((p) => [p, state.files.get(p)])) });
      state.dirty.clear();
      const stat = `${changed.length} file${changed.length === 1 ? '' : 's'} changed`;
      s.tool(
        'Bash',
        { command: `git add -A && git commit -m ${JSON.stringify(message)}`, description: 'Commit the change' },
        `[${branch} ${commitToken(branch, i)}] ${message}\n ${stat}`,
        { took: 700 },
      );
      s.wait(2500);
      return w;
    },
    /** A tool call still running: the session is working on it right now. */
    pending(command, description) {
      s.tool('Bash', { command, description });
      return w;
    },
    end(text) {
      s.end(text);
      s.wait(60_000);
      return w;
    },
    wait(ms) {
      s.wait(ms);
      return w;
    },
    /**
     * From here on, lines are written when the task's session starts (the
     * stand-in `claude` appends them), timed so the last one is "now". `ago`
     * is how long before that the first one happened.
     */
    live(ago) {
      live = s.fork(-ago);
      s = live;
      return w;
    },
    /**
     * End the live part on a permission prompt for `command`: what follows
     * Allow and what follows Deny are told by `allow(w)` and `deny(w)`.
     */
    ask(command, description, rule, { allow, deny }) {
      s.tool('Bash', { command, description });
      const askedAt = s.now();
      const branchOf = (fn) => {
        const fork = s.fork(askedAt);
        const prev = s;
        s = fork;
        fn(w);
        s = prev;
        return fork;
      };
      outcomes = {
        request: { tool_name: 'Bash', tool_input: { command, description }, rule },
        allow: branchOf(allow),
        deny: branchOf(deny),
      };
      return w;
    },
    /** For the outcome functions: the answer to the command just asked about. */
    result(text, opts) {
      s.result(text, opts);
      s.wait(2000);
      return w;
    },
    done() {
      return {
        history: history.lines,
        live: live ? live.lines : null,
        outcomes: outcomes && {
          request: outcomes.request,
          allow: outcomes.allow.lines,
          deny: outcomes.deny.lines,
        },
        commits: state.commits,
        uncommitted: Object.fromEntries([...state.dirty].map((p) => [p, state.files.get(p)])),
      };
    },
  };
  return w;
}
