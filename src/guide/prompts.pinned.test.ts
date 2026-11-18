/**
 * The grouping and notes calls without a Context step send exactly what they
 * sent before #444: their prompts and system prompts, pinned as fixed
 * strings captured from main before the change (not computed by the code
 * under test).
 */
import { afterEach, expect, it } from 'vitest';
import { buildBranchDiff } from './blocks';
import { statReason } from './budget';
import { changed, text } from './fixtures';
import { GROUP_SYSTEM, setOneshotRunner, writeGuide, writeNotes, type OneshotRequest } from './writer';

/** Captured on origin/main at 43fb987, before #444. */
const BEFORE = {
  group: "The change: 2 file(s), 2 block(s).\n\n[e05z] src/OrderMailer.php @@ -1,6 +1,8 @@\n   function send($o) {\n+    if ($o->confirmed) return;\n+    $o->confirmed = true;\n     mail($o);\n\n[0e7t] src/Retry.php (new file) @@ -0,0 +1,6 @@\n+<?php\n+function retry() {\n+  return 1;\n+}\n+// a\n+// b",
  notes: "The change's other groups:\n- Tests\n\nGroup: Send once\nSummary: Marks the order first.\nFiles to note:\n- src/Retry.php\n\nThe group's blocks:\n\n[e05z] src/OrderMailer.php @@ -1,6 +1,8 @@\n   function send($o) {\n+    if ($o->confirmed) return;\n+    $o->confirmed = true;\n     mail($o);\n\n[0e7t] src/Retry.php (new file) @@ -0,0 +1,6 @@\n+<?php\n+function retry() {\n+  return 1;\n+}\n+// a\n+// b",
  groupSystem: "You write a review guide for a code change on a branch. The change is given as blocks. Each block starts with its id in square brackets, then its file path and its changed lines. Group the blocks by what they do (one intent per group), and order the groups so a reviewer reads foundations before what builds on them. For each group write a short title (under 60 characters, sentence case) and a summary of one or two sentences saying what the group changes and why. Put every block id in exactly one group. Use the ids exactly as given, bare (for example \"a1b2\"), with nothing added. Do not invent ids. Write plainly; do not praise or judge the code. Then, under \"careful\", list at most 5 files a reviewer should read with extra care because a mistake there would be costly or easy to miss: stored data or its shape, security or permissions, money, concurrency, a contract other code relies on. For each give its file path exactly as shown and a reason of one short line (under 80 characters) saying what makes it risky, for example \"changes the session id written on restart\". Do not list a file just because it is large or new. Leave \"careful\" empty when nothing stands out.",
  notesSystem: "You help a reviewer read one group of a code change. You are given the titles of all the change's groups (for context), this group's title and summary, a list of files to note, and the group's changed blocks: each block starts with its id in square brackets, then its file path and its changed lines. For each file to note, write two texts. First, \"note\": one or two short sentences (under 220 characters in all) on WHY this file changes as part of this group: the part it plays in what the group sets out to do, the reason the change is needed in this file, or what it enables, protects or keeps working. Do not restate what changed: the reviewer reads the diff right beside your note. Mention what changed only when the reason cannot be told without it. If the reason is not evident from the lines, the title or the summary, state the file's role in the group plainly rather than guess at intent. Then \"line\": the same thing as the note in a few words, for a list of the group's files: its gist, rewritten shorter, never its first words cut off. At most 50 characters, no trailing period. Do not restate the group's title. Use each file path exactly as listed, and write nothing for files not listed. Write plainly; describe, do not praise or judge the code.",
};

let prev: ReturnType<typeof setOneshotRunner> | null = null;
afterEach(() => {
  if (prev) setOneshotRunner(prev);
  prev = null;
});

it('without a Context, the grouping and notes calls send what they sent before #444', async () => {
  const diff = buildBranchDiff(
    [
      changed(
        'src/OrderMailer.php',
        text(['<?php', 'class OrderMailer {', '  function send($o) {', '    mail($o);', '  }', '}']),
        text(['<?php', 'class OrderMailer {', '  function send($o) {', '    if ($o->confirmed) return;', '    $o->confirmed = true;', '    mail($o);', '  }', '}']),
      ),
      changed('src/Retry.php', null, text(['<?php', 'function retry() {', '  return 1;', '}', '// a', '// b'])),
    ],
    statReason,
  );
  expect(diff.order).toEqual(["e05z", "0e7t"]);
  const calls: OneshotRequest[] = [];
  prev = setOneshotRunner(async (req) => {
    calls.push(req);
    const s = req.systemPrompt === GROUP_SYSTEM ? { groups: [{ title: 'Send once', summary: 'S.', blocks: diff.order }] } : { notes: [] };
    return { code: 0, stdout: JSON.stringify({ type: 'result', structured_output: s }), stderr: '', timedOut: false };
  });
  await writeGuide(diff, { base: 'main' });
  await writeNotes(diff, { title: 'Send once', summary: 'Marks the order first.', blocks: diff.order }, { groupTitles: ['Send once', 'Tests'] });
  expect(calls[0]!.prompt).toBe(BEFORE.group);
  expect(calls[0]!.systemPrompt).toBe(BEFORE.groupSystem);
  expect(calls[1]!.prompt).toBe(BEFORE.notes);
  expect(calls[1]!.systemPrompt).toBe(BEFORE.notesSystem);
});
