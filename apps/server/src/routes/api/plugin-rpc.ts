/**
 * PR-3: Plugin RPC route.
 *
 * Single channel for all structured plugin commands:
 *
 *   POST /api/sessions/:id/plugin-rpc
 *   {
 *     "pluginId": "codex",
 *     "action": "regenerate",     // OR runtimeId, never both
 *     "payload": { ... }
 *   }
 *
 * Two dispatch modes:
 *
 *   1. Action-level (`action` set) — delegates to an RpcActionDecl handler
 *      declared in `manifest.rpc[action]` or a framework default. Returns a
 *      single JSON response.
 *
 *   2. Runtime-level (`runtimeId` set) — invokes `executeTurn` with
 *      `input.manualTrigger` so the target runtime runs through the full
 *      turn pipeline (prompt assembly, tool loop, proposal commit) and any
 *      event-triggered downstreams fire automatically.
 *
 *      Sub-modes via `manifest.execution`:
 *        - `'sync'` (default) — awaits runtime completion, commits proposals,
 *          returns a JSON summary with the runtime results.
 *        - `'background'` (M4) — schedules work off-request and returns a
 *          jobId; progress streams via `plugin-data.changed` SSE under the
 *          reserved `_jobs` namespace.
 *
 * Resolution order for action dispatch:
 *   1. Plugin-declared action (manifest.rpc[action])
 *   2. Framework default (registry.getFrameworkDefault)
 */

import { Hono } from "hono";
import {
	executeTurn,
	processRuntimeResult,
	createTurnEmitter,
	createRpcHandlerStoreView,
} from "@covel/runtime";
import { RpcDispatchError, RpcValidationError } from "@covel/runtime";
import { getPluginTrustInfo } from "@covel/plugin-loader";
import type { TurnInput } from "@covel/shared";
import { loadSessionConfig } from "./load-session-config.js";

interface PluginRpcBody {
	readonly pluginId?: string;
	readonly action?: string;
	readonly runtimeId?: string;
	readonly payload?: unknown;
	readonly expectsBackgroundFollower?: boolean;
}

/**
 * Decode the `X-Plugin-User-Settings` request header — base64(json) whose
 * body is `{ [pluginId]: { [settingKey]: value } }`. Malformed input (bad
 * base64, non-JSON, wrong shape) is treated as "no settings" so a single
 * corrupt client request can't poison the turn executor.
 */
function decodePluginUserSettingsHeader(
	raw: string | undefined,
): Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined {
	if (!raw) return undefined;
	try {
		const json = JSON.parse(
			Buffer.from(raw, "base64").toString("utf-8"),
		) as unknown;
		if (!json || typeof json !== "object" || Array.isArray(json))
			return undefined;
		const out: Record<string, Record<string, unknown>> = {};
		for (const [pluginId, bucket] of Object.entries(
			json as Record<string, unknown>,
		)) {
			if (!bucket || typeof bucket !== "object" || Array.isArray(bucket))
				continue;
			out[pluginId] = { ...(bucket as Record<string, unknown>) };
		}
		return Object.keys(out).length > 0 ? out : undefined;
	} catch {
		return undefined;
	}
}

export const pluginRpcRoutes = new Hono();

pluginRpcRoutes.post("/:id/plugin-rpc", async (c) => {
	const store = c.get("store");
	const executor = c.get("rpcExecutor");
	const sessionId = c.req.param("id");

	const session = await store.getSession(sessionId);
	if (!session) {
		return c.json(
			{ status: "error", error: `Session "${sessionId}" not found` },
			404,
		);
	}

	let body: PluginRpcBody;
	try {
		body = await c.req.json<PluginRpcBody>();
	} catch {
		return c.json({ status: "error", error: "invalid JSON body" }, 400);
	}

	if (!body.pluginId || typeof body.pluginId !== "string") {
		return c.json(
			{ status: "error", error: "pluginId (string) is required" },
			400,
		);
	}

	if (body.action && body.runtimeId) {
		return c.json(
			{ status: "error", error: "action and runtimeId are mutually exclusive" },
			400,
		);
	}

	if (!body.action && !body.runtimeId) {
		return c.json(
			{ status: "error", error: "either action or runtimeId is required" },
			400,
		);
	}

	// ── Runtime-level manual trigger ─────────────────────────────────
	//
	// Runs the target runtime through the full turn pipeline (prompt assembly,
	// tool loop, proposal commit) with `input.manualTrigger` set. Event-
	// triggered followers chain automatically via the executor's post-group
	// event loop.
	//
	// Execution sub-mode comes from `manifest.execution`:
	//   - `'sync'` (default) → await results, commit, return JSON.
	//   - `'background'` (M4) → not yet implemented, returns 501.
	if (body.runtimeId) {
		const pluginRegistry = c.get("pluginRegistry");
		const llmAdapter = c.get("llmAdapter");
		const pluginGateway = c.get("pluginGateway");
		const pluginUtils = c.get("pluginUtils");
		const getPluginSource = c.get("getPluginSource");
		const loadRuntimeFn = c.get("loadRuntimeFn");
		const toolExecutor = c.get("toolExecutor");
		const resolveModel = c.get("resolveModel");
		const eventBus = c.get("eventBus");
		const compactorRunner = c.get("compactorRunner");
		const hookPipeline = c.get("hookPipeline");
		const sessionLock = c.get("sessionLock");
		const mediaStore = c.get("mediaStore");
		const prepareToolsForSession = c.get("prepareToolsForSession");

		// Activate the session's plugins in the registry — idempotent but
		// required after a server restart or when this is the first request
		// for this session.
		const sessionPlugins = session.activePlugins as
			| readonly string[]
			| undefined;
		if (sessionPlugins) {
			for (const pid of sessionPlugins) {
				pluginRegistry.activate(pid, sessionId);
			}
		}

		const activeRuntimes = pluginRegistry.getActiveRuntimes(sessionId);
		const target = activeRuntimes.find((rt) => rt.name === body.runtimeId);
		if (!target) {
			return c.json(
				{
					status: "error",
					error: `runtime "${body.runtimeId}" not active in session ${sessionId}`,
					code: "runtime-not-active",
				},
				404,
			);
		}
		if (target.pluginId !== body.pluginId) {
			return c.json(
				{
					status: "error",
					error: `runtime "${body.runtimeId}" belongs to plugin "${target.pluginId}", not "${body.pluginId}"`,
					code: "plugin-mismatch",
				},
				400,
			);
		}

		// Approval gate — trust comes from plugin discovery source, NOT from
		// the manifest's `pluginType` field. `pluginType` is author-supplied and
		// could be forged by a third-party plugin claiming `core-plugin` to
		// auto-bypass approval. `entry.source` is set by bootstrap from the
		// discovery pipeline, which clamps non-first-dir plugins to 'community'
		// so they can't escalate. Fallback to id-prefix detection (via
		// getPluginTrustInfo) when source is absent for defense in depth.
		const entry = pluginRegistry.get(body.pluginId);
		const trustInfo = getPluginTrustInfo(body.pluginId, entry?.source);
		const gate = c.get("rpcApprovalGate");
		const verdict = gate.evaluate({
			sessionId,
			pluginId: body.pluginId,
			action: `runtime:${body.runtimeId}`,
			payload: body.payload,
			trustLevel: trustInfo.source,
			description: target.description,
		});
		if (verdict.status === "pending") {
			return c.json(
				{
					status: "approval-required",
					approvalId: verdict.approvalId,
					pending: verdict.pending,
				},
				202,
			);
		}
		if (verdict.status === "rejected") {
			return c.json(
				{
					status: "error",
					error: `approval queue is full (limit ${verdict.limit}); try again after resolving pending approvals`,
					code: "queue-full",
				},
				429,
			);
		}

		const worldDataPluginId = pluginRegistry.findPluginByCapability(
			sessionId,
			"world-data-provider",
		);
		const sessionConfig = await loadSessionConfig(
			store,
			sessionId,
			session.worldId ?? undefined,
			worldDataPluginId,
		);
		const turnGetConfig = (): Readonly<Record<string, unknown>> =>
			sessionConfig;

		// Audit F7: player-authored plugin settings travel with the request
		// as a base64-encoded JSON header (`X-Plugin-User-Settings`) sourced
		// from the unified SettingsStore. The body map keys on pluginId so
		// executor merges per-runtime defaults with the matching player
		// bucket. Invalid JSON / bad base64 are silently ignored — settings
		// degrade gracefully to manifest defaults rather than failing the
		// turn. Never persisted server-side; request-scoped only.
		const userSettingsMap = decodePluginUserSettingsHeader(
			c.req.header("X-Plugin-User-Settings"),
		);

		await prepareToolsForSession?.(sessionId);
		// Just-in-time activation: community plugins skip eager tool import in
		// bootstrap. Now that the approval gate has cleared this RPC, ensure the
		// plugin's `tools.local` are registered before the runtime executes —
		// otherwise tool calls would resolve to `undefined` in the executor.
		// No-op for builtin/official plugins (already loaded at boot) and for
		// already-activated community plugins (idempotent).
		await c.get("activatePluginLocalTools")?.(body.pluginId);

		const turnId = crypto.randomUUID();

		// Build outputKind lookup once — shared between sync and background paths.
		const outputKindMap = new Map<string, string>();
		const runtimeCapabilitiesMap = new Map<string, readonly string[]>();
		for (const rt of activeRuntimes) {
			outputKindMap.set(rt.name, rt.outputKind ?? "plugin");
			runtimeCapabilitiesMap.set(rt.name, rt.capabilities ?? []);
		}

		// Executes the manual-trigger turn end-to-end: run through the turn
		// pipeline, commit proposals for every emitted runtime result, and
		// return a summary suitable for the JSON response or the `_jobs`
		// writeback.
		type ManualTurnSummary = {
			readonly turnId: string;
			readonly runtimeResults: ReadonlyArray<{
				readonly runtimeId: string;
				readonly pluginId: string;
				readonly status: string;
				readonly durationMs: number;
				readonly error?: string;
				readonly output: unknown;
			}>;
			readonly durationMs: number;
			readonly abortReason?: string;
			readonly deferredFollowers: ReadonlyArray<{
				readonly runtimeId: string;
				readonly pluginId: string;
				readonly triggerEvent: {
					readonly topic: string;
					readonly data: Readonly<Record<string, unknown>>;
				};
			}>;
		};

		const runManualTurn = async (): Promise<ManualTurnSummary> => {
			const emitter = createTurnEmitter({ store, eventBus, sessionId, turnId });
			const turnInput: TurnInput = {
				sessionId,
				turnId,
				playerMessage: "",
				locale: session.locale ?? "zh-CN",
				manualTrigger: {
					runtimeId: body.runtimeId!,
					...(body.payload !== undefined && body.payload !== null
						? { payload: body.payload as Record<string, unknown> }
						: {}),
				},
				...(session.runtimeModelOverrides
					? { runtimeModelOverrides: session.runtimeModelOverrides }
					: {}),
				...(userSettingsMap && Object.keys(userSettingsMap).length > 0
					? { userSettings: userSettingsMap }
					: {}),
			};

			const result = await sessionLock.withLock(sessionId, () =>
				executeTurn(turnInput, activeRuntimes, {
					loadRuntime: loadRuntimeFn,
					llm: llmAdapter,
					...(pluginGateway ? { gateway: pluginGateway } : {}),
					...(pluginUtils ? { utils: pluginUtils } : {}),
					...(getPluginSource ? { getPluginSource } : {}),
					getConfig: turnGetConfig,
					store,
					...(mediaStore ? { mediaStore } : {}),
					toolExecutor,
					resolveModel,
					emitter,
					// Without eventBus the executor's emitSubEvent calls (turn.started,
					// runtime.started/completed, turn.completed, …) silently no-op,
					// leaving the trace timeline with only the two LLM lifecycle events
					// that flow through the parallel `emitter` channel. The /debug page
					// then can't tell the runtime ever finished. Wire it through so
					// manual-trigger turns produce the same trace surface as auto turns.
					eventBus,
					compactor: compactorRunner,
					worldDataPluginId,
					...(hookPipeline ? { hookPipeline } : {}),
				}),
			);

			for (const rr of result.runtimeResults) {
				const kind = outputKindMap.get(rr.runtimeId) ?? "plugin";
				const processOpts = {
					...(hookPipeline ? { hookPipeline } : {}),
					eventBus,
					emitter,
					capabilities: runtimeCapabilitiesMap.get(rr.runtimeId) ?? [],
				};
				await processRuntimeResult(rr, store, sessionId, kind, processOpts);
			}

			const summary = result.runtimeResults.map((rr) => ({
				runtimeId: rr.runtimeId,
				pluginId: rr.pluginId,
				status: rr.status,
				durationMs: rr.durationMs,
				...(rr.error ? { error: rr.error } : {}),
				output: rr.output,
			}));

			return {
				turnId,
				runtimeResults: summary,
				durationMs: result.durationMs,
				...(result.abortReason ? { abortReason: result.abortReason } : {}),
				deferredFollowers: result.deferredFollowers ?? [],
			};
		};

		// Audit P1: run ONE background follower off-cycle and write its result
		// back into `_jobs/<jobId>`. Routes the follower through the same
		// `executeTurn(...)` pipeline as a manual-trigger turn so the handler
		// gets a real `recursiveCall`, a real `assetProgress` emitter, hook
		// firing, deferredFollower fan-out, and `asset.generated` events on
		// the SSE stream — instead of the bespoke handler invocation that
		// hard-stubbed `recursiveCall` to throw and dropped `assetProgress` /
		// `asset.generated` entirely.
		//
		// Running each follower in its own isolated turn keeps job ids 1:1
		// with followers — simpler to surface in the UI than a tree of nested
		// jobs.
		const runDeferredFollower = async (args: {
			readonly jobId: string;
			readonly runtimeId: string;
			readonly pluginId: string;
			readonly triggerEvent: {
				readonly topic: string;
				readonly data: Readonly<Record<string, unknown>>;
			};
			readonly followerTurnId: string;
			readonly startedAt: string;
		}): Promise<void> => {
			const followerManifest = activeRuntimes.find(
				(rt) => rt.name === args.runtimeId,
			);
			if (!followerManifest) {
				await store.setPluginData({
					id: `${sessionId}:${args.pluginId}:_jobs:${args.jobId}`,
					sessionId,
					pluginId: args.pluginId,
					namespace: "_jobs",
					key: args.jobId,
					value: {
						status: "failed",
						progress: 100,
						runtimeId: args.runtimeId,
						turnId: args.followerTurnId,
						triggerEvent: args.triggerEvent,
						startedAt: args.startedAt,
						completedAt: new Date().toISOString(),
						error: "follower manifest not found in active set",
					},
					createdAt: args.startedAt,
					updatedAt: new Date().toISOString(),
				});
				return;
			}

			try {
				const followerEmitter = createTurnEmitter({
					store,
					eventBus,
					sessionId,
					turnId: args.followerTurnId,
				});
				const followerInput: TurnInput = {
					sessionId,
					turnId: args.followerTurnId,
					playerMessage: "",
					locale: session.locale ?? "zh-CN",
					manualTrigger: {
						runtimeId: args.runtimeId,
						triggerEvent: args.triggerEvent,
					},
					...(session.runtimeModelOverrides
						? { runtimeModelOverrides: session.runtimeModelOverrides }
						: {}),
					...(userSettingsMap && Object.keys(userSettingsMap).length > 0
						? { userSettings: userSettingsMap }
						: {}),
				};

				const turnResult = await executeTurn(followerInput, activeRuntimes, {
					loadRuntime: loadRuntimeFn,
					llm: llmAdapter,
					...(pluginGateway ? { gateway: pluginGateway } : {}),
					...(pluginUtils ? { utils: pluginUtils } : {}),
					...(getPluginSource ? { getPluginSource } : {}),
					getConfig: turnGetConfig,
					store,
					...(mediaStore ? { mediaStore } : {}),
					toolExecutor,
					resolveModel,
					emitter: followerEmitter,
					eventBus,
					compactor: compactorRunner,
					worldDataPluginId,
					...(hookPipeline ? { hookPipeline } : {}),
				});

				const followerResult = turnResult.runtimeResults.find(
					(rr) => rr.runtimeId === args.runtimeId,
				);

				// Commit proposals for every runtime the follower turn produced
				// (the targeted follower plus any sync event-chained downstream
				// runtimes that fired in its mini-pipeline). asset.generated /
				// ui.rendered / state.patch.applied flow through the per-turn
				// emitter so the SSE stream reaches the chat UI in real time.
				for (const rr of turnResult.runtimeResults) {
					const kind = outputKindMap.get(rr.runtimeId) ?? "plugin";
					const processOpts = {
						...(hookPipeline ? { hookPipeline } : {}),
						eventBus,
						emitter: followerEmitter,
						capabilities: runtimeCapabilitiesMap.get(rr.runtimeId) ?? [],
					};
					await processRuntimeResult(rr, store, sessionId, kind, processOpts);
				}

				// The follower turn may itself surface deferredFollowers — schedule
				// them as their own `_jobs/<jobId>` so a chain of background
				// followers stays observable to the UI.
				if (
					turnResult.deferredFollowers &&
					turnResult.deferredFollowers.length > 0
				) {
					await scheduleDeferredFollowers(turnResult.deferredFollowers);
				}

				// Audit P1-6: business failure detection. When the handler
				// explicitly reports failure (status: 'failed' / non-empty error),
				// surface that on both `runtimeResult.status` and the persisted
				// `_jobs/<jobId>.value.status` so the UI transitions pending →
				// failed correctly. We also treat an executor-reported `failed` /
				// `skipped` runtime as a job-level failure.
				const outputRecord = (followerResult?.output ?? {}) as Record<
					string,
					unknown
				>;
				const executorReportedFailure =
					followerResult?.status === "failed" ||
					followerResult?.status === "skipped";
				const handlerSaysFailed =
					outputRecord.status === "failed" ||
					(typeof outputRecord.error === "string" &&
						outputRecord.error.length > 0);
				const isFailure = executorReportedFailure || handlerSaysFailed;
				const runtimeStatus: "success" | "failed" = isFailure
					? "failed"
					: "success";
				const runtimeError =
					followerResult?.error ??
					(handlerSaysFailed && typeof outputRecord.error === "string"
						? outputRecord.error
						: isFailure
							? "runtime reported failure"
							: undefined);

				// Audit P1-6: persist the derived job status so a UI watching
				// `_jobs/<jobId>` doesn't see stale `pending` after a business
				// failure, and so the runtimeResults entry inside the job
				// matches what the trace pipeline records above.
				const jobStatus: "done" | "failed" = isFailure ? "failed" : "done";
				const completedAt = new Date().toISOString();
				await store.setPluginData({
					id: `${sessionId}:${args.pluginId}:_jobs:${args.jobId}`,
					sessionId,
					pluginId: args.pluginId,
					namespace: "_jobs",
					key: args.jobId,
					value: {
						status: jobStatus,
						progress: 100,
						runtimeId: args.runtimeId,
						turnId: args.followerTurnId,
						triggerEvent: args.triggerEvent,
						startedAt: args.startedAt,
						completedAt,
						durationMs: followerResult?.durationMs ?? turnResult.durationMs,
						...(runtimeError ? { error: runtimeError } : {}),
						runtimeResults: [
							{
								runtimeId: args.runtimeId,
								pluginId: args.pluginId,
								status: runtimeStatus,
								durationMs: followerResult?.durationMs ?? turnResult.durationMs,
								...(runtimeError ? { error: runtimeError } : {}),
								output: followerResult?.output ?? outputRecord,
							},
						],
					},
					createdAt: args.startedAt,
					updatedAt: completedAt,
				});
			} catch (err) {
				await store
					.setPluginData({
						id: `${sessionId}:${args.pluginId}:_jobs:${args.jobId}`,
						sessionId,
						pluginId: args.pluginId,
						namespace: "_jobs",
						key: args.jobId,
						value: {
							status: "failed",
							progress: 100,
							runtimeId: args.runtimeId,
							turnId: args.followerTurnId,
							triggerEvent: args.triggerEvent,
							startedAt: args.startedAt,
							completedAt: new Date().toISOString(),
							error: err instanceof Error ? err.message : String(err),
						},
						createdAt: args.startedAt,
						updatedAt: new Date().toISOString(),
					})
					.catch(() => {
						// Writeback itself failed — frontend will see stale pending record.
					});
			}
		};

		// Write the pending `_jobs/<jobId>` rows synchronously and spawn
		// setImmediate tasks to run each follower. Returns the job ids so
		// the sync response body can reference them.
		const scheduleDeferredFollowers = async (
			followers: ReadonlyArray<{
				readonly runtimeId: string;
				readonly pluginId: string;
				readonly triggerEvent: {
					readonly topic: string;
					readonly data: Readonly<Record<string, unknown>>;
				};
			}>,
		): Promise<
			ReadonlyArray<{ readonly jobId: string; readonly runtimeId: string }>
		> => {
			const scheduled: { jobId: string; runtimeId: string }[] = [];
			for (const follower of followers) {
				const jobId = crypto.randomUUID();
				const followerTurnId = crypto.randomUUID();
				const startedAt = new Date().toISOString();
				await store.setPluginData({
					id: `${sessionId}:${follower.pluginId}:_jobs:${jobId}`,
					sessionId,
					pluginId: follower.pluginId,
					namespace: "_jobs",
					key: jobId,
					value: {
						status: "pending",
						progress: 5,
						runtimeId: follower.runtimeId,
						turnId: followerTurnId,
						triggerEvent: follower.triggerEvent,
						startedAt,
					},
					createdAt: startedAt,
					updatedAt: startedAt,
				});
				scheduled.push({ jobId, runtimeId: follower.runtimeId });
				setImmediate(() => {
					void runDeferredFollower({
						jobId,
						runtimeId: follower.runtimeId,
						pluginId: follower.pluginId,
						triggerEvent: follower.triggerEvent,
						followerTurnId,
						startedAt,
					});
				});
			}
			return scheduled;
		};

		const writeExpectedFollowerFailureJob = async (args: {
			readonly turnId: string;
			readonly error: string;
			readonly runtimeResults?: ReadonlyArray<{
				readonly runtimeId: string;
				readonly pluginId: string;
				readonly status: string;
				readonly durationMs: number;
				readonly error?: string;
				readonly output: unknown;
			}>;
		}): Promise<{ readonly jobId: string; readonly runtimeId: string }> => {
			const jobId = crypto.randomUUID();
			const now = new Date().toISOString();
			await store.setPluginData({
				id: `${sessionId}:${body.pluginId}:_jobs:${jobId}`,
				sessionId,
				pluginId: body.pluginId!,
				namespace: "_jobs",
				key: jobId,
				value: {
					status: "failed",
					progress: 100,
					runtimeId: body.runtimeId,
					turnId: args.turnId,
					startedAt: now,
					completedAt: now,
					error: args.error,
					...(args.runtimeResults
						? { runtimeResults: args.runtimeResults }
						: {}),
					reason: "expected-background-follower-missing",
				},
				createdAt: now,
				updatedAt: now,
			});
			return { jobId, runtimeId: body.runtimeId! };
		};

		const mode: "sync" | "background" = target.execution ?? "sync";

		// ── Background mode ────────────────────────────────────────────
		//
		// Write `_jobs/{jobId}` as `pending` immediately so the frontend can
		// render a loading state, return 202 + {jobId}, and continue the
		// work in `setImmediate`. Dependencies (store, eventBus, executor,
		// locks) are all captured from the bootstrap closure via `c.get(...)`
		// above — they are long-lived and safe to reference after the
		// response has been flushed.
		//
		// The `_jobs` namespace is reserved by the framework. Any write to
		// `setPluginData` flows through the store-proxy, which emits
		// `plugin-data.changed` on the event bus; SSE subscribers pick it
		// up and update the UI. No bespoke streaming protocol.
		if (mode === "background") {
			const jobId = crypto.randomUUID();
			const startedAt = new Date().toISOString();

			try {
				await store.setPluginData({
					id: `${sessionId}:${body.pluginId}:_jobs:${jobId}`,
					sessionId,
					pluginId: body.pluginId,
					namespace: "_jobs",
					key: jobId,
					value: {
						status: "pending",
						progress: 5,
						runtimeId: body.runtimeId,
						turnId,
						...(body.payload !== undefined ? { payload: body.payload } : {}),
						startedAt,
					},
					createdAt: startedAt,
					updatedAt: startedAt,
				});
			} catch (err) {
				return c.json(
					{
						status: "error",
						error:
							err instanceof Error
								? err.message
								: "failed to enqueue background job",
						code: "background-enqueue-failed",
					},
					500,
				);
			}

			// Detach from the request: run off-cycle so the 202 response can
			// flush immediately. Errors inside the async closure never
			// surface as an HTTP status — they're written back into
			// `_jobs/{jobId}` and picked up by the frontend via SSE.
			setImmediate(() => {
				void (async (): Promise<void> => {
					try {
						const summary = await runManualTurn();
						const completedAt = new Date().toISOString();

						// Audit F8: `runManualTurn()` resolves even when the runtime's
						// own handler threw — `executeOneRuntime` catches the exception
						// and records the runtime as `status: 'failed'` inside
						// `runtimeResults`. If we blindly wrote `status: 'done'` the
						// frontend would render a failed image generation as success.
						// Treat any failed runtime result as top-level failure and
						// surface the first error message so the UI can show it.
						const failedResult = summary.runtimeResults.find(
							(r) => r.status === "failed",
						);
						const topLevelStatus = failedResult ? "failed" : "done";
						const failureMessage =
							failedResult?.error ??
							(failedResult ? "runtime reported failure" : undefined);

						await store.setPluginData({
							id: `${sessionId}:${body.pluginId}:_jobs:${jobId}`,
							sessionId,
							pluginId: body.pluginId!,
							namespace: "_jobs",
							key: jobId,
							value: {
								status: topLevelStatus,
								progress: 100,
								runtimeId: body.runtimeId,
								turnId: summary.turnId,
								...(body.payload !== undefined
									? { payload: body.payload }
									: {}),
								startedAt,
								completedAt,
								durationMs: summary.durationMs,
								runtimeResults: summary.runtimeResults,
								...(failureMessage ? { error: failureMessage } : {}),
								...(summary.abortReason
									? { abortReason: summary.abortReason }
									: {}),
							},
							createdAt: startedAt,
							updatedAt: completedAt,
						});
					} catch (err) {
						const completedAt = new Date().toISOString();
						await store
							.setPluginData({
								id: `${sessionId}:${body.pluginId}:_jobs:${jobId}`,
								sessionId,
								pluginId: body.pluginId!,
								namespace: "_jobs",
								key: jobId,
								value: {
									status: "failed",
									progress: 100,
									runtimeId: body.runtimeId,
									turnId,
									...(body.payload !== undefined
										? { payload: body.payload }
										: {}),
									startedAt,
									completedAt,
									error:
										err instanceof Error
											? err.message
											: "runtime execution failed",
								},
								createdAt: startedAt,
								updatedAt: completedAt,
							})
							.catch(() => {
								// Terminal failure — both the runtime AND the writeback
								// blew up. Nothing useful to do from here; the frontend
								// will see the stale `pending` record and can reconcile.
							});
					}
				})();
			});

			return c.json(
				{
					status: "accepted",
					jobId,
					pending: true,
					turnId,
					runtimeId: body.runtimeId,
				},
				202,
			);
		}

		// ── Sync mode ──────────────────────────────────────────────────
		//
		// Audit F1: the sync turn may surface `deferredFollowers` — event-chain
		// followers with `execution: 'background'` that were skipped so the
		// user gets an immediate response. Persist one `_jobs/<jobId>` pending
		// row per follower BEFORE responding so the frontend can render a
		// loading state, then fire each follower with setImmediate so the
		// response flushes without waiting for image generation etc.
		//
		// UX: some sync entry runtimes are only prompt-builders for a background
		// follower (e.g. image prompt-generator → image-generator). When the
		// client declares `expectsBackgroundFollower`, write a `_jobs` placeholder
		// immediately and run the sync prompt-builder off-request as well. The UI
		// can then show "generating prompt" at once instead of waiting 20–40s for
		// the prompt LLM call before any job row exists.
		if (body.expectsBackgroundFollower === true) {
			const placeholderJobId = crypto.randomUUID();
			const startedAt = new Date().toISOString();
			try {
				await store.setPluginData({
					id: `${sessionId}:${body.pluginId}:_jobs:${placeholderJobId}`,
					sessionId,
					pluginId: body.pluginId,
					namespace: "_jobs",
					key: placeholderJobId,
					value: {
						status: "pending",
						progress: 1,
						runtimeId: body.runtimeId,
						turnId,
						startedAt,
						phase: "prompt",
						message: "Generating image prompt...",
					},
					createdAt: startedAt,
					updatedAt: startedAt,
				});
			} catch (err) {
				return c.json(
					{
						status: "error",
						error:
							err instanceof Error
								? err.message
								: "failed to enqueue prompt job",
						code: "prompt-job-enqueue-failed",
					},
					500,
				);
			}

			setImmediate(() => {
				void (async (): Promise<void> => {
					try {
						const summary = await runManualTurn();
						const deferredJobs =
							summary.deferredFollowers.length > 0
								? await scheduleDeferredFollowers(summary.deferredFollowers)
								: [];
						const completedAt = new Date().toISOString();
						const failedResult = summary.runtimeResults.find(
							(r) => r.status === "failed",
						);
						if (deferredJobs.length > 0) {
							await store.setPluginData({
								id: `${sessionId}:${body.pluginId}:_jobs:${placeholderJobId}`,
								sessionId,
								pluginId: body.pluginId!,
								namespace: "_jobs",
								key: placeholderJobId,
								value: {
									status: "done",
									progress: 100,
									runtimeId: body.runtimeId,
									turnId: summary.turnId,
									startedAt,
									completedAt,
									durationMs: summary.durationMs,
									phase: "prompt",
									message: "Image prompt generated; image job queued.",
									runtimeResults: summary.runtimeResults,
									deferredJobs,
									...(summary.abortReason
										? { abortReason: summary.abortReason }
										: {}),
								},
								createdAt: startedAt,
								updatedAt: completedAt,
							});
							return;
						}
						await store.setPluginData({
							id: `${sessionId}:${body.pluginId}:_jobs:${placeholderJobId}`,
							sessionId,
							pluginId: body.pluginId!,
							namespace: "_jobs",
							key: placeholderJobId,
							value: {
								status: "failed",
								progress: 100,
								runtimeId: body.runtimeId,
								turnId: summary.turnId,
								startedAt,
								completedAt,
								durationMs: summary.durationMs,
								error:
									failedResult?.error ??
									`runtime "${body.runtimeId}" completed without emitting a matching background follower event`,
								runtimeResults: summary.runtimeResults,
								reason: "expected-background-follower-missing",
								...(summary.abortReason
									? { abortReason: summary.abortReason }
									: {}),
							},
							createdAt: startedAt,
							updatedAt: completedAt,
						});
					} catch (err) {
						const completedAt = new Date().toISOString();
						await store
							.setPluginData({
								id: `${sessionId}:${body.pluginId}:_jobs:${placeholderJobId}`,
								sessionId,
								pluginId: body.pluginId!,
								namespace: "_jobs",
								key: placeholderJobId,
								value: {
									status: "failed",
									progress: 100,
									runtimeId: body.runtimeId,
									turnId,
									startedAt,
									completedAt,
									error:
										err instanceof Error
											? err.message
											: "runtime execution failed",
								},
								createdAt: startedAt,
								updatedAt: completedAt,
							})
							.catch(() => undefined);
					}
				})();
			});

			return c.json(
				{
					status: "accepted",
					jobId: placeholderJobId,
					pending: true,
					turnId,
					runtimeId: body.runtimeId,
					phase: "prompt",
				},
				202,
			);
		}

		try {
			const summary = await runManualTurn();
			const deferredJobs =
				summary.deferredFollowers.length > 0
					? await scheduleDeferredFollowers(summary.deferredFollowers)
					: [];
			return c.json({
				status: "ok",
				turnId: summary.turnId,
				runtimeResults: summary.runtimeResults,
				durationMs: summary.durationMs,
				...(summary.abortReason ? { abortReason: summary.abortReason } : {}),
				...(deferredJobs.length > 0 ? { deferredJobs } : {}),
			});
		} catch (err) {
			return c.json(
				{
					status: "error",
					error:
						err instanceof Error ? err.message : "runtime execution failed",
					code: "runtime-execution-failed",
				},
				500,
			);
		}
	}

	// PR-7: approval gate. Look up the resolved entry first so we know its
	// trust level, then ask the gate whether the call can proceed. Builtin
	// and official trust auto-allow; community trust either re-uses a cached
	// session approval or returns approval-required for the dialog flow.
	//
	// We deliberately resolve the entry BEFORE invoking the gate so that
	// unknown actions surface as a 404 instead of getting parked in the
	// approval queue forever.
	//
	// LOW-3: framework default actions are namespace-less but still need a
	// canonical sentinel for the request shape. The dispatcher requires
	// `pluginId === "framework"` for framework defaults. Plugin-declared
	// actions still use the real plugin ID.
	const FRAMEWORK_PLUGIN_SENTINEL = "framework";
	const registry = c.get("rpcRegistry");
	const gate = c.get("rpcApprovalGate");
	let entryTrust: "builtin" | "official" | "community" = "community";
	let entryDescription: string | undefined;
	const pluginEntry =
		body.pluginId === FRAMEWORK_PLUGIN_SENTINEL
			? undefined
			: registry.getPluginAction(body.pluginId, body.action!);
	if (pluginEntry) {
		entryTrust = pluginEntry.trustLevel;
		entryDescription = pluginEntry.description;
	} else if (body.pluginId === FRAMEWORK_PLUGIN_SENTINEL) {
		const fwEntry = registry.getFrameworkDefault(body.action!);
		if (fwEntry) {
			entryTrust = fwEntry.trustLevel; // always 'builtin'
			entryDescription = fwEntry.description;
		} else {
			return c.json(
				{
					status: "error",
					error: `unknown framework action "${body.action}"`,
					code: "unknown-action",
				},
				404,
			);
		}
	} else {
		return c.json(
			{
				status: "error",
				error: `unknown action "${body.action}" for plugin "${body.pluginId}"`,
				code: "unknown-action",
			},
			404,
		);
	}

	const verdict = gate.evaluate({
		sessionId,
		pluginId: body.pluginId,
		action: body.action!,
		payload: body.payload,
		trustLevel: entryTrust,
		description: entryDescription,
	});

	if (verdict.status === "pending") {
		return c.json(
			{
				status: "approval-required",
				approvalId: verdict.approvalId,
				pending: verdict.pending,
			},
			202,
		);
	}

	if (verdict.status === "rejected") {
		// MEDIUM-1: pending queue is full. Map to 429 so clients back off.
		return c.json(
			{
				status: "error",
				error: `approval queue is full (limit ${verdict.limit}); try again after resolving pending approvals`,
				code: "queue-full",
			},
			429,
		);
	}

	// Action-level dispatch.
	try {
		const rpcStore =
			entryTrust === "builtin" || entryTrust === "official"
				? store
				: createRpcHandlerStoreView(store, {
						sessionId,
						pluginId: body.pluginId,
					});
		const dispatch = await executor.dispatch(
			{
				pluginId: body.pluginId,
				action: body.action!,
				payload: body.payload,
			},
			{ sessionId, store: rpcStore },
		);
		return c.json({ status: "ok", result: dispatch.result });
	} catch (err) {
		if (err instanceof RpcValidationError) {
			return c.json({ status: "error", error: err.message }, 400);
		}
		if (err instanceof RpcDispatchError) {
			const code = err.code === "unknown-action" ? 404 : 500;
			return c.json(
				{ status: "error", error: err.message, code: err.code },
				code,
			);
		}
		return c.json(
			{
				status: "error",
				error:
					err instanceof Error ? err.message : "plugin-rpc dispatch failed",
			},
			500,
		);
	}
});
