/**
 * The tasks and projects the message box's `@` list offers (#154). The shell
 * provides them, the way it provides `TaskOpenContext`; the composer reads
 * them with `useMentionSource()` instead of having them threaded through
 * the transcript pane.
 */

import { createContext, useContext } from 'react';
import type { Project, Task } from '../types';

export interface MentionSource {
  tasks: readonly Task[];
  projects: readonly Project[];
}

/** Outside a provider (a test) there is nothing to mention but files. */
export const MentionSourceContext = createContext<MentionSource>({ tasks: [], projects: [] });
MentionSourceContext.displayName = 'MentionSourceContext';

export function useMentionSource(): MentionSource {
  return useContext(MentionSourceContext);
}
