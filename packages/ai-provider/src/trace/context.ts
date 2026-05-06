/**
 * Trace context for end-to-end observability.
 * Follows the tracing chain from runtime-kernel-spec.md:
 * traceId → runId → branchId → turnId → runtimeId → pluginId
 */
export interface TraceContext {
	traceId: string;
	runId?: string;
	branchId?: string;
	turnId?: string;
	runtimeId?: string;
	pluginId?: string;
}
