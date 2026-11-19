/**
 * A trigger's draft moved to the message box (#448) waits there as a card,
 * folded, until a message carrying it reaches the session -- by whatever
 * path: the box, a held message's release, after a restart. This hears every
 * delivered text (`onSessionSubmit`) and lets the store retire such a card.
 * It only ever removes a card; it never sends.
 */

import { useEffect } from 'react';
import { onSessionSubmit } from '../transcript/send';
import { noteTriggerTextSent } from '../../triggers/store';

export function useTriggerBoxWatch(): void {
  useEffect(() => onSessionSubmit((taskId, text) => noteTriggerTextSent(taskId, text)), []);
}
