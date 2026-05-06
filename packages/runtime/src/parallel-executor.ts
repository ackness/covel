/**
 * Parallel executor — runs same-priority runtimes concurrently with failure isolation.
 */

import type { RuntimeManifest, RuntimeResult } from "@covel/shared";

/** A function that executes a single runtime and returns its result. */
export type RuntimeExecuteFn = (
	manifest: RuntimeManifest,
) => Promise<RuntimeResult>;

export interface FailureResolution {
	/** Runtimes to skip (dependent on failed runtime). */
	readonly skip: ReadonlyArray<{
		readonly manifest: RuntimeManifest;
		readonly reason: string;
	}>;
	/** Runtimes safe to continue. */
	readonly continue: ReadonlyArray<{
		readonly manifest: RuntimeManifest;
		readonly degraded: boolean;
	}>;
}

/**
 * Execute a group of runtimes in parallel using Promise.allSettled.
 * Returns results keyed by runtime name.
 */
export async function executeParallel(
	runtimes: readonly RuntimeManifest[],
	executeFn: RuntimeExecuteFn,
): Promise<ReadonlyMap<string, RuntimeResult>> {
	const settled = await Promise.allSettled(runtimes.map((rt) => executeFn(rt)));

	const entries: Array<[string, RuntimeResult]> = runtimes.map((rt, i) => {
		const outcome = settled[i];
		if (outcome.status === "fulfilled") {
			return [rt.name, outcome.value];
		}
		const errorMessage =
			outcome.reason instanceof Error
				? outcome.reason.message
				: String(outcome.reason);
		const failedResult: RuntimeResult = {
			pluginId: "",
			runtimeId: rt.name,
			runId: "",
			turnId: "",
			status: "failed",
			output: null,
			toolCalls: [],
			durationMs: 0,
			error: errorMessage,
			timestamp: new Date().toISOString(),
		};
		return [rt.name, failedResult];
	});

	return new Map(entries);
}

/**
 * Determine which runtimes should be skipped vs. continued
 * after an upstream failure.
 *
 * Rules:
 * - Runtimes that declare an input dependency on the failed runtime → skip
 * - Runtimes with no dependency on the failed runtime → continue
 * - Narrator (priority 500) → always continue (degraded mode)
 */
export function resolveFailure(
	failed: RuntimeManifest,
	pending: readonly RuntimeManifest[],
	dependencies: ReadonlyMap<string, readonly string[]>,
): FailureResolution {
	const skip: Array<{
		readonly manifest: RuntimeManifest;
		readonly reason: string;
	}> = [];
	const cont: Array<{
		readonly manifest: RuntimeManifest;
		readonly degraded: boolean;
	}> = [];

	for (const rt of pending) {
		const deps = dependencies.get(rt.name) ?? [];
		const dependsOnFailed = deps.includes(failed.name);

		if (dependsOnFailed) {
			// Narrator (priority 500) always continues in degraded mode
			if (rt.priority === 500) {
				cont.push({ manifest: rt, degraded: true });
			} else {
				skip.push({
					manifest: rt,
					reason: `Depends on failed runtime '${failed.name}'`,
				});
			}
		} else {
			cont.push({ manifest: rt, degraded: false });
		}
	}

	return { skip, continue: cont };
}
