/**
 * src/capture/index.ts
 *
 * Public surface of the capture workstream, exactly as frozen in
 * docs/INTERFACES.md:
 *
 *   startCapture(): Promise<CaptureHandle>
 *   onCaptureUpdate(cb): () => void
 *   deriveStatus(messages): TaskStatus
 *   usageSummary(): Promise<{ inputTokens; outputTokens; sinceTs }>
 *
 * Nothing outside this directory may import src/capture/adapter.ts: the JSONL
 * format stops here (CLAUDE.md hard rule #1).
 */

export { startCapture, onCaptureUpdate } from './watcher';
export type { CaptureHandle, CaptureUpdate } from './watcher';

export { deriveStatus } from './status';

export { usageSummary } from './usage';
export type { UsageSummary } from './usage';

// --- Additive to docs/INTERFACES.md, for the shell's startup indicator -----
export { onCaptureProgress } from './watcher';
export type { CaptureProgress } from './watcher';

// Named constants other workstreams may want to display or reason about.
export { RUNNING_WINDOW_MS } from './status';
export { USAGE_WINDOW_MS, usageBreakdown } from './usage';
export type { UsageBreakdown } from './usage';
