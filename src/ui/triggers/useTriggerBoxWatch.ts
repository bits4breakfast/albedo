/**
 * Cards that go because what they offered already went to Claude another way
 * (#448). Only ever removes a card; it never sends.
 *
 *   - A draft moved to the message box waits there as a folded card until a
 *     message carrying it reaches the session -- by whatever path: the box, a
 *     held message's release, after a restart (`onSessionSubmit`).
 *   - A CI card goes when the CI queue's copy of the same commit's failure
 *     went with an ordinary message (`onQueuedCiTaken`): sending the card too
 *     would tell Claude twice.
 */

import { useEffect } from 'react';
import { onSessionSubmit } from '../transcript/send';
import { onQueuedCiTaken } from '../transcript/ciFailure';
import { noteCiFailureSent, noteTriggerTextSent } from '../../triggers/store';

export function useTriggerBoxWatch(): void {
  useEffect(() => {
    const offs = [
      onSessionSubmit((taskId, text) => noteTriggerTextSent(taskId, text)),
      onQueuedCiTaken((taskId, sha) => noteCiFailureSent(taskId, sha)),
    ];
    return () => offs.forEach((off) => off());
  }, []);
}
