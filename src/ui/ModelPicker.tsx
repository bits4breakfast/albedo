/**
 * ModelPicker — which model the session is on, and a way to change it.
 *
 * The current model is read from the transcript (`message.model` on the last
 * assistant line, via `contextUsage`), never from the terminal: it shows what
 * the last reply actually used, so it cannot drift from reality.
 *
 * Changing it types `/model <alias>` into the pty with `sendToSession`. That is
 * input only -- no output is parsed -- so the two-channel rule holds. It is
 * offered only while the task is idle, because the same text sent mid-turn
 * would land in the agent's prompt as a message instead of running a command.
 *
 * The transcript only learns of the switch on the next assistant reply, so
 * after choosing, the picker says so until the model it reads back matches.
 *
 * A session with no reply yet -- just after `/clear`, or a new task -- has no
 * model to read. The process has one all the same, so the picker shows the
 * best-known stand-in, marked as assumed until a reply confirms it: the model
 * this task's previous session last replied with (`/clear` keeps it), else
 * the one Albedo spawned the task with, else the user's Claude Code default.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Task } from '../types';
import { contextUsage, onCaptureUpdate } from '../capture';
import { sendToSession, useSendsWait } from './transcript/send';
import { loadDefaultModel, loadModelChoices, type ModelChoice } from '../capture/modelCatalog';
import { getTaskModel, setTaskModel } from './taskModel';

/** Used only when Claude Code's model catalog cannot be read. */
const FALLBACK_CHOICES: ModelChoice[] = [
  { id: 'opus', name: 'opus' },
  { id: 'sonnet', name: 'sonnet' },
  { id: 'haiku', name: 'haiku' },
];

const FALLBACK_MS = 15_000;

/** The choice the transcript's model id is, by exact id or by family alias. */
function choiceFor(model: string | null, choices: readonly ModelChoice[]): string | null {
  if (!model) return null;
  const exact = choices.find((c) => c.id === model);
  if (exact) return exact.id;
  return choices.find((c) => !c.id.startsWith('claude-') && model.includes(c.id))?.id ?? null;
}

export default function ModelPicker({ task }: { task: Task }) {
  const sessionId = task.sessionId;
  const taskId = task.id;
  const [model, setModel] = useState<string | null>(null);
  const [assumed, setAssumed] = useState<string | null>(null);
  // The last model read for this task, which outlives a session change.
  const lastSeenRef = useRef<{ taskId: number; model: string } | null>(null);
  const [choices, setChoices] = useState<ModelChoice[]>(FALLBACK_CHOICES);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    void loadModelChoices().then((c) => {
      if (aliveRef.current && c.length > 0) setChoices(c);
    });
  }, []);

  const load = useCallback(async () => {
    let read: string | null = null;
    if (sessionId) {
      try {
        read = (await contextUsage(sessionId))?.model ?? null;
      } catch {
        /* the gauge panel already reports unavailable usage */
      }
    }
    if (!aliveRef.current) return;
    setModel(read);
    if (read) {
      lastSeenRef.current = { taskId, model: read };
      setAssumed(null);
      return;
    }
    const carried = lastSeenRef.current?.taskId === taskId ? lastSeenRef.current.model : null;
    const stand = carried ?? getTaskModel(taskId) ?? (await loadDefaultModel());
    if (aliveRef.current) setAssumed(stand);
  }, [sessionId, taskId]);

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    aliveRef.current = true;
    setPending(null);
    setFailed(false);
    void load();
    return () => {
      aliveRef.current = false;
    };
  }, [load, task.id]);

  useEffect(() => {
    let off: () => void = () => {};
    try {
      const o = onCaptureUpdate(() => void loadRef.current());
      if (typeof o === 'function') off = o;
    } catch {
      /* polling below still covers it */
    }
    const t = setInterval(() => void loadRef.current(), FALLBACK_MS);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);

  const shown = model ?? assumed;
  const current = choiceFor(shown, choices);
  // Once the transcript reports the requested model the switch has landed.
  useEffect(() => {
    if (pending && choiceFor(model, choices) === pending) setPending(null);
  }, [pending, model, choices]);

  const idle = task.status === 'idle';
  // While a send would be held (offline, messages waiting, a turn running),
  // there is no switching: the picker shows the switch as under way at once.
  const waiting = useSendsWait(task.id);
  const choose = async (choice: string) => {
    if (choice === current && !pending) return;
    setFailed(false);
    // Held only if sends started waiting since the menu was offered: it then
    // goes once the session is idle, so the switch is under way all the same.
    const ok = (await sendToSession(task.id, `/model ${choice}`)) !== 'failed';
    if (ok) {
      setPending(choice);
      // The process is on it from now, reply or not: a /clear before the
      // first reply should still show it.
      lastSeenRef.current = { taskId: task.id, model: choice };
      // Remembered for this task, so a restart resumes on it rather than on
      // the user's default.
      setTaskModel(task.id, choice);
    } else setFailed(true);
  };

  const label = shown ? shown.replace(/^claude-/, '') : 'Model Unknown';
  const title =
    (model ? `${model}. ` : assumed ? `Probably ${assumed}: confirmed on the first reply. ` : '') +
    (!idle
      ? 'Switching models is only offered while the task is idle'
      : waiting
        ? 'Not available while messages are waiting to send'
        : 'Sends /model to this session');
  const nameOf = (id: string) => choices.find((c) => c.id === id)?.name ?? id;

  return (
    <span className="model-pick">
      {/* Only when the menu cannot name it: otherwise the select already
          shows the current model and this said the same thing twice. */}
      {current === null && pending === null ? (
        <span className="model-pick-name" title={shown ?? undefined}>
          {label}
        </span>
      ) : null}
      <select
        className="model-pick-select"
        aria-label="Change model"
        title={title}
        disabled={!idle || waiting}
        value={pending ?? current ?? ''}
        onChange={(e) => void choose(e.target.value)}
      >
        {current === null && pending === null ? (
          <option value="" disabled>
            Change…
          </option>
        ) : null}
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {pending ? <span className="model-pick-note">→ {nameOf(pending)} on next reply</span> : null}
      {failed ? <span className="model-pick-note">No live terminal for this task</span> : null}
    </span>
  );
}
