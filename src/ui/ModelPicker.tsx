/**
 * ModelPicker — which model the session is on, and a way to change it.
 *
 * The current model is read from the transcript (`message.model` on the last
 * assistant line, via `contextUsage`), never from the terminal: it shows what
 * the last reply actually used, so it cannot drift from reality.
 *
 * Changing it types `/model <alias>` into the pty with `submitPty`. That is
 * input only -- no output is parsed -- so the two-channel rule holds. It is
 * offered only while the task is idle, because the same text sent mid-turn
 * would land in the agent's prompt as a message instead of running a command.
 *
 * The transcript only learns of the switch on the next assistant reply, so
 * after choosing, the picker says so until the model it reads back matches.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Task } from '../types';
import { contextUsage, onCaptureUpdate } from '../capture';
import { submitPty } from './Terminal';
import { loadModelChoices, type ModelChoice } from '../capture/modelCatalog';
import { setTaskModel } from './taskModel';

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
  const [model, setModel] = useState<string | null>(null);
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
    if (!sessionId) {
      setModel(null);
      return;
    }
    try {
      const u = await contextUsage(sessionId);
      if (aliveRef.current) setModel(u?.model ?? null);
    } catch {
      /* the gauge panel already reports unavailable usage */
    }
  }, [sessionId]);

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

  const current = choiceFor(model, choices);
  // Once the transcript reports the requested model the switch has landed.
  useEffect(() => {
    if (pending && current === pending) setPending(null);
  }, [pending, current]);

  const idle = task.status === 'idle';
  const choose = async (choice: string) => {
    if (choice === current && !pending) return;
    setFailed(false);
    const ok = await submitPty(task.id, `/model ${choice}`);
    if (ok) {
      setPending(choice);
      // Remembered for this task, so a restart resumes on it rather than on
      // the user's default.
      setTaskModel(task.id, choice);
    } else setFailed(true);
  };

  const label = model ? model.replace(/^claude-/, '') : 'Model Unknown';
  const title =
    (model ? `${model}. ` : '') +
    (!idle ? 'Switching models is only offered while the task is idle' : 'Sends /model to this session');
  const nameOf = (id: string) => choices.find((c) => c.id === id)?.name ?? id;

  return (
    <span className="model-pick">
      {/* Only when the menu cannot name it: otherwise the select already
          shows the current model and this said the same thing twice. */}
      {current === null && pending === null ? (
        <span className="model-pick-name" title={model ?? undefined}>
          {label}
        </span>
      ) : null}
      <select
        className="model-pick-select"
        aria-label="Change model"
        title={title}
        disabled={!idle}
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
