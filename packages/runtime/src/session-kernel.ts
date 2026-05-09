/**
 * Session Kernel — public facade for runtime output processing.
 *
 * Public imports stay stable through this file while the implementation is
 * split across focused adjacent modules.
 */

export { normalizeOutput } from "./session-output-normalizer.js";
export { createCommitPipeline } from "./session-commit-pipeline.js";
export type { CommitPipeline, KernelStore } from "./session-commit-pipeline.js";
export { processRuntimeResult } from "./session-runtime-result.js";
export type { ProcessRuntimeResultOutput } from "./session-runtime-result.js";
export { createTraceRecorder } from "./session-trace-recorder.js";
export type { TraceRecorder } from "./session-trace-recorder.js";
