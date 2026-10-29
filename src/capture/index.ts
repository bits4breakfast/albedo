/**
 * src/capture/index.ts
 *
 * Public surface of the capture module (see docs/ARCHITECTURE.md):
 *
 *   startCapture(): Promise<CaptureHandle>
 *   onCaptureUpdate(cb): () => void
 *   deriveStatus(messages): TaskStatus
 *   usageSummary(): Promise<{ inputTokens; outputTokens; sinceTs }>
 *
 * Nothing outside this directory may import src/capture/adapter.ts: the JSONL
 * format stops here (CLAUDE.md hard rule #1).
 */

export { startCapture, onCaptureUpdate, listDiskSessions, importTranscripts } from './watcher';
export type { CaptureHandle, CaptureUpdate, DiskSession } from './watcher';

export { deriveStatus } from './status';

/** Attached images, recovered from a placeholder row's raw line. */
export { imageAt, imagesIn, SEQ_STRIDE } from './adapter';
export type { TranscriptImage } from './adapter';

/** A compaction's boundary and summary, and the notices Claude Code writes. */
export { compactBoundaryOf, compactSummaryOf, isNoticeLine } from './adapter';

/** Turn edges and output tokens, for the transcript's working line. */
export { turnEdgeOf, outputTokensOf } from './adapter';

/** A slash command Claude Code ran itself, recorded as a `system` line. */
export { isLocalCommandLine } from './adapter';

/** The claude.ai link a "Remote Control is active" line carries. */
export { remoteControlUrlOf } from './adapter';

/** Work running in the background: shells, agents, monitors, wake-ups, timers. */
export { runningInBackground, nextChangeAt } from './background';
export { isBackgroundNotice } from './adapter';
export type { BackgroundItem, BackgroundKind } from './background';

/** Which task sent a message from another session (`peers.ts`). */
export { peerMessageIdOf } from './adapter';
export { senderTaskOf } from './peers';
export type { CompactBoundary, CompactSummary } from './adapter';

export { usageSummary } from './usage';
export type { UsageSummary } from './usage';

/** Per-session context-window occupancy, for the task list and header. */
export { contextUsage, contextUsageForSessions, contextBands } from './context';
export type { ContextUsage, ContextBands } from './context';

/**
 * Rolling-window token totals across all sessions. `windowUsage` lives in
 * usage.ts rather than context.ts so it shares usageSummary's query and the
 * two can never drift; the exported surface is the same either way.
 */
export { windowUsage } from './usage';
export type { WindowUsage } from './usage';

// --- For the shell's startup indicator ------------------------------------
// What is waiting in Claude Code's input queue, per session (in memory).
export { queuedFor, queueSettlesAt, onQueueChange } from './queue';
export type { QueuedEntry } from './queue';

// The permission mode each session was last seen in (in memory).
export { permissionModeFor, loadPermissionMode, onPermissionModeChange } from './permissionMode';
export type { PermissionMode } from './adapter';

export { onCaptureProgress } from './watcher';
export type { CaptureProgress } from './watcher';

// Named constants other workstreams may want to display or reason about.
export { RUNNING_WINDOW_MS } from './status';
export { USAGE_WINDOW_MS, WEEK_WINDOW_MS, usageBreakdown } from './usage';
export type { UsageBreakdown } from './usage';

// The tier table is exported so the shell can label an 'inferred' limit
// honestly rather than presenting a guess as fact.
export { CONTEXT_WINDOW_TIERS, CHARS_PER_TOKEN } from './context';
