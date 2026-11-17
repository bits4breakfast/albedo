/**
 * The start gate's own rules (#439): which SessionStart is this process's,
 * and what Send Anyway may clear.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  START_STAMP_SLACK_MS,
  __resetStartGate,
  awaitingStart,
  clearAwaitingStartIf,
  noteSessionStarted,
  sendAnyway,
  setAwaitingStart,
  startIsThisProcess,
  startNeededByHand,
} from './startGate';

afterEach(() => __resetStartGate());

describe('startIsThisProcess', () => {
  it('takes a whole-second stamp from the same second as a spawn late in it', () => {
    // Spawned at x.900; the hook ran at x.950 and stamped floor(x).
    const spawned = 1_700_000_000_900;
    expect(startIsThisProcess(1_700_000_000_000, spawned)).toBe(true);
  });

  it('allows exactly the slack, and not a millisecond more', () => {
    const spawned = 1_700_000_000_900;
    expect(START_STAMP_SLACK_MS).toBe(1_000);
    expect(startIsThisProcess(spawned - 1_000, spawned)).toBe(true);
    expect(startIsThisProcess(spawned - 1_001, spawned)).toBe(false);
    // The previous second's stamp belongs to an earlier process.
    expect(startIsThisProcess(1_699_999_999_000, spawned)).toBe(false);
  });
});

describe('clearing the wait by hand', () => {
  it('clears only the wait that began at `since`', () => {
    setAwaitingStart(1, 100);
    expect(clearAwaitingStartIf(1, 99)).toBe(false);
    expect(awaitingStart(1)).toBe(true);
    expect(clearAwaitingStartIf(1, 100)).toBe(true);
    expect(awaitingStart(1)).toBe(false);
  });

  it('Send Anyway on a stale warning leaves a respawn’s wait alone, and remembers nothing', () => {
    setAwaitingStart(1, 100);
    setAwaitingStart(1, 200); // respawned since the warning was drawn
    expect(sendAnyway(1, 100)).toBe(false);
    expect(awaitingStart(1)).toBe(true);
    expect(startNeededByHand(1)).toBe(false);
    expect(sendAnyway(1, 200)).toBe(true);
    expect(startNeededByHand(1)).toBe(true);
  });

  it('a reported start forgets that Send Anyway was needed', () => {
    setAwaitingStart(1, 100);
    sendAnyway(1, 100);
    setAwaitingStart(1, 300);
    noteSessionStarted(1);
    expect(awaitingStart(1)).toBe(false);
    expect(startNeededByHand(1)).toBe(false);
  });
});
