import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { KernelSession } from "@covel/kernel";
import type { CommandBus } from "@covel/plugin-runtime";
import type { KernelTurnResult } from "@covel/shared";
import type { ApiKeyEnv } from "../middleware/api-key-injection.js";
import type { ServerStore } from "../store/types.js";
import { toBlockEnvelope } from "./actions/block-envelope.js";
import { isPrivateHost } from "./actions/ssrf-guard.js";

const customPresetSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  provider: z.string().min(1).max(128),
  baseUrl: z.string().max(2048).default(""),
  model: z.string().min(1).max(256),
  protocol: z.string().max(64).optional(),
});

const slotConfigSchema = z.object({
  slots: z.record(z.string(), z.object({ presetId: z.string().min(1).max(128) })).optional(),
  customPresets: z.array(customPresetSchema).max(20).optional(),
  runtimePriority: z.record(z.string(), z.number().int().min(0).max(1000)).optional(),
});

/**
 * POST /actions — SSE streaming endpoint.
 *
 * Maps kernel turn execution to SseEnvelope events that the frontend expects:
 * - narrative → message.completed
 * - ui.render blocks → block.emitted (BlockEnvelope)
 * - state.patch → state.patch.applied
 * - end → flow.completed
 */

interface SseEnvelope {
  type: string;
  requestId: string;
  traceId: string;
  sessionId: string;
  turnId: string;
  flowId: string;
  seq: number;
  timestamp: string;
  payload: Record<string, unknown>;
}

export function createStatePatchId(turnId: string, seq: number): string {
  return `patch_${turnId}_${seq}`;
}

export function createActionsRoute(deps: {
  getOrCreateSession: (sessionId: string) => KernelSession;
  commandBus: CommandBus;
  store: ServerStore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  presetRegistry?: {
    addPreset: (preset: any) => void;
    removePreset: (id: string) => void;
  };
}) {
  const { getOrCreateSession, commandBus, store } = deps;

  // Per-session run tracking (capped to prevent unbounded growth)
  const SESSION_RUNS_MAX = 1000;
  const sessionRuns = new Map<string, { runId: string; branchId: string; lastUsed: number }>();

  function getRunInfo(sessionId: string) {
    let info = sessionRuns.get(sessionId);
    if (!info) {
      // Evict oldest entries when exceeding max size (Map preserves insertion order)
      if (sessionRuns.size >= SESSION_RUNS_MAX) {
        const deleteCount = Math.floor(SESSION_RUNS_MAX / 4);
        const iter = sessionRuns.keys();
        for (let i = 0; i < deleteCount; i++) {
          const key = iter.next().value;
          if (key) sessionRuns.delete(key);
        }
      }
      info = { runId: `run-${sessionId}`, branchId: "branch-main", lastUsed: Date.now() };
      sessionRuns.set(sessionId, info);
    } else {
      info = { ...info, lastUsed: Date.now() };
      sessionRuns.set(sessionId, info);
    }
    return info;
  }

  const route = new Hono<ApiKeyEnv>();

  route.post("/", async (c) => {
    let body: {
      requestId: string;
      type: "send_message" | "execute_command" | "submit_block_response" | "start_session" | "retry_runtime";
      sessionId: string;
      locale?: string;
      payload: Record<string, unknown>;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "INVALID_JSON", message: "Malformed JSON body" }, 400);
    }

    const { requestId, type, sessionId, locale, payload = {} } = body;

    if (!requestId || !type || !sessionId) {
      return c.json(
        { code: "INVALID_REQUEST", message: "requestId, type, and sessionId are required" },
        400
      );
    }

    const session = await store.getSession(sessionId);
    if (!session) {
      return c.json({ code: "SESSION_NOT_FOUND", message: "Session not found" }, 404);
    }

    const apiKeys = c.get("apiKeys") ?? {};

    // Parse X-Slot-Config header for per-request slot overrides, custom presets, and runtime priority
    let slotOverrides: Record<string, { presetId: string }> | undefined;
    let customPresetDefs: z.infer<typeof customPresetSchema>[] | undefined;
    let runtimePriorityOverrides: Record<string, number> | undefined;
    const slotConfigHeader = c.req.header("x-slot-config");
    if (slotConfigHeader && slotConfigHeader.length > 8192) {
      console.warn("[actions] X-Slot-Config header exceeds 8KB size limit, skipping");
    } else if (slotConfigHeader) {
      try {
        const raw = JSON.parse(atob(slotConfigHeader));
        const decoded = slotConfigSchema.parse(raw);
        if (decoded.slots && Object.keys(decoded.slots).length > 0) {
          slotOverrides = decoded.slots;
        }
        if (decoded.customPresets && decoded.customPresets.length > 0) {
          customPresetDefs = decoded.customPresets;
        }
        if (decoded.runtimePriority && Object.keys(decoded.runtimePriority).length > 0) {
          runtimePriorityOverrides = decoded.runtimePriority;
        }
      } catch {
        console.warn("[actions] Failed to decode/validate X-Slot-Config header, skipping");
      }
    }

    return streamSSE(c, async (stream) => {
      let seq = 0;
      const flowId = `flow_${Date.now().toString(36)}`;

      function envelope(
        eventType: string,
        turnId: string,
        traceId: string,
        eventPayload: Record<string, unknown>
      ): SseEnvelope {
        return {
          type: eventType,
          requestId,
          traceId,
          sessionId,
          turnId,
          flowId,
          seq: seq++,
          timestamp: new Date().toISOString(),
          payload: eventPayload,
        };
      }

      async function emit(eventType: string, turnId: string, traceId: string, eventPayload: Record<string, unknown>) {
        const env = envelope(eventType, turnId, traceId, eventPayload);
        // Record to trace event log for debug inspection
        await store.addTraceEvent(sessionId, env);
        await stream.writeSSE({
          data: JSON.stringify(env),
          event: env.type,
          id: String(env.seq),
        });
      }

      // Register custom presets from frontend (ephemeral, per-request scoped).
      // Use a unique suffix per request to avoid collisions from concurrent requests.
      const reqSuffix = `_req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const registeredCustomIds: string[] = [];
      if (customPresetDefs && deps.presetRegistry) {
        // Validate baseUrl against allowlist if configured (SSRF prevention)
        const allowedBaseUrls = process.env.ALLOWED_BASE_URLS
          ? process.env.ALLOWED_BASE_URLS.split(",").map((s) => s.trim())
          : null;
        const currentTier = process.env.DEPLOYMENT_TIER ?? "self";

        for (const def of customPresetDefs) {
          if (def.baseUrl) {
            // Block custom baseUrl for non-self tiers when no allowlist configured
            if (!allowedBaseUrls && currentTier !== "self") {
              console.warn(`[actions] Blocking custom baseUrl: ALLOWED_BASE_URLS not configured for tier ${currentTier}`);
              continue;
            }
            // Block private/internal IP ranges to prevent SSRF
            try {
              const url = new URL(def.baseUrl);
              const host = url.hostname;
              if (isPrivateHost(host)) {
                console.warn(`[actions] Blocked baseUrl targeting private network: ${def.baseUrl}`);
                continue;
              }
            } catch {
              console.warn(`[actions] Blocked invalid baseUrl: ${def.baseUrl}`);
              continue;
            }
            // Check against allowlist if configured
            if (allowedBaseUrls && !allowedBaseUrls.some((allowed) => def.baseUrl === allowed || def.baseUrl.startsWith(allowed + "/"))) {
              console.warn(`[actions] Blocked baseUrl not in ALLOWED_BASE_URLS: ${def.baseUrl}`);
              continue;
            }
          }
          const scopedId = def.id + reqSuffix;
          deps.presetRegistry.addPreset({
            id: scopedId,
            name: def.name,
            provider: def.provider,
            model: def.model,
            baseUrl: def.baseUrl || undefined,
            protocol: def.protocol,
            tier: "heavy",
            supportedModes: ["text"],
            enabled: true,
          });
          registeredCustomIds.push(scopedId);
        }
        // Remap slot overrides to use scoped preset IDs
        if (slotOverrides) {
          for (const [slotName, slotDef] of Object.entries(slotOverrides)) {
            const originalId = slotDef.presetId;
            const matchingDef = customPresetDefs.find((d) => d.id === originalId);
            if (matchingDef) {
              slotOverrides[slotName] = { presetId: originalId + reqSuffix };
            }
          }
        }
      }

      try {
        // ── Slash command ──────────────────────────────────────────
        if (type === "execute_command") {
          const commandText = (payload.command ?? payload.content) as string;
          const turnId = `turn_${Date.now().toString(36)}`;
          const traceId = `trace_${Date.now().toString(36)}`;

          await emit("flow.phase.changed", turnId, traceId, { phase: "command" });

          if (!commandText) {
            await emit("message.completed", turnId, traceId, {
              messageId: `msg_${seq}`,
              content: "⚠️ command text is required",
            });
          } else {
            try {
              const result = (await commandBus.dispatch(commandText, {
                sessionId,
                locale: locale ?? "zh-CN",
              })) as Record<string, unknown> | undefined;

              if (result?.content) {
                await store.addMessage(sessionId, "assistant", result.content as string, { turnId });
                await emit("message.completed", turnId, traceId, {
                  messageId: `msg_${seq}`,
                  content: result.content,
                });
              }
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : "Command failed";
              await emit("message.completed", turnId, traceId, {
                messageId: `msg_${seq}`,
                content: `⚠️ ${msg}`,
              });
            }
          }

          await emit("flow.completed", turnId, traceId, { flowId });
          return;
        }

        // ── retry_runtime → re-execute from specific runtime ──────────
        if (type === "retry_runtime") {
          const retryRuntimeId = (payload.runtimeId as string) || undefined;
          const kernelSession = getOrCreateSession(sessionId);

          // Rebuild context (same as normal turn)
          const chatHistory = (await store.listMessages(sessionId)).map((m) => ({
            role: m.role,
            content: m.content,
          }));
          const world = await store.getWorld(session.worldId);
          // Load persisted state snapshot for kernel context rehydration
          const retrySnapshot = await store.getStateSnapshot(sessionId);

          kernelSession.setContext({
            world: world
              ? {
                  name: world.name,
                  description: world.description,
                  ...(world.lore ? { lore: world.lore } : {}),
                  ...(world.dimensions ? { dimensions: world.dimensions } : {}),
                }
              : undefined,
            chat: chatHistory,
            ...(retrySnapshot
              ? { state: ((retrySnapshot as Record<string, unknown>).state ?? retrySnapshot) as Record<string, unknown> }
              : {}),
          });

          const provTurnId = `turn_${Date.now().toString(36)}`;
          const provTraceId = `trace_${Date.now().toString(36)}`;

          await emit("flow.phase.changed", provTurnId, provTraceId, { phase: "model" });
          await emit("runtime.progress", provTurnId, provTraceId, {
            type: "runtime.started" as const,
            runtimeId: "kernel",
            pluginId: "kernel",
            label: "retry",
            detail: retryRuntimeId ?? "all",
            timestamp: new Date().toISOString(),
          });

          const streamedRuntimeIds = new Set<string>();
          const runtimeKindMap = new Map<string, string>();
          let resolveBackgroundDone: (() => void) | undefined;
          let backgroundTaskCount = 0;
          let backgroundTaskDoneCount = 0;
          const backgroundDonePromise = new Promise<void>((resolve) => {
            resolveBackgroundDone = resolve;
          });

          let retryTurnResult: KernelTurnResult | undefined;
          retryTurnResult = await kernelSession.retryTurn(retryRuntimeId, {
            apiKeys,
            slotOverrides,
            runtimePriorityOverrides,
            onProgress: async (evt) => {
              if (evt.type === "message.delta") {
                // Only forward deltas for non-cached runtimes
                if (evt.detail !== "[cached]") {
                  streamedRuntimeIds.add(evt.runtimeId);
                  await emit("message.delta", provTurnId, provTraceId, {
                    runtimeId: evt.runtimeId,
                    pluginId: evt.pluginId,
                    delta: evt.detail ?? "",
                  });
                }
              } else {
                if (evt.type === "runtime.started" && evt.label) {
                  const slashIdx = evt.label.indexOf("/");
                  if (slashIdx >= 0) {
                    runtimeKindMap.set(evt.runtimeId, evt.label.slice(slashIdx + 1));
                  }
                }
                await emit("runtime.progress", provTurnId, provTraceId, { ...evt });
              }
            },
            onBackgroundTaskDone: async (task) => {
              try {
                if (!retryTurnResult) {
                  console.warn("[actions] onBackgroundTaskDone fired before retryTurn resolved");
                  return;
                }
                const { turnId: tid, traceId: trid } = retryTurnResult;
                if (task.status === "completed" && task.result?.text) {
                  await store.addMessage(sessionId, "assistant", task.result.text, { turnId: tid, runtimeId: task.runtimeId });
                  const msgId = `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
                  await emit("message.completed", tid, trid, {
                    messageId: msgId,
                    content: task.result.text,
                    background: true,
                    runtimeId: task.runtimeId,
                    pluginId: task.pluginId,
                  });
                }
              } finally {
                backgroundTaskDoneCount++;
                if (backgroundTaskDoneCount >= backgroundTaskCount) {
                  resolveBackgroundDone?.();
                }
              }
            },
          });
          const turnResult = retryTurnResult;

          const { turnId, traceId } = turnResult;

          // Emit render blocks — skip cached narrative blocks
          const narrativeSourceRuntimeIds: string[] = [];
          for (const proposal of turnResult.proposals) {
            for (const item of proposal.items) {
              if (item.kind === "narrative.append") {
                narrativeSourceRuntimeIds.push(proposal.runtimeId);
              }
            }
          }

          let narrativeIndex = 0;
          for (const block of turnResult.render.blocks) {
            if (block.type === "narrative") {
              const sourceRuntimeId = block.source?.runtimeId
                ?? narrativeSourceRuntimeIds[narrativeIndex]
                ?? "";
              narrativeIndex++;
              const retryNarrativeKind = runtimeKindMap.get(sourceRuntimeId);
              await store.addMessage(sessionId, "assistant", block.content as string, { turnId, runtimeId: sourceRuntimeId, kind: retryNarrativeKind });
              const msgId = `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
              await emit("message.completed", turnId, traceId, {
                messageId: msgId,
                content: block.content,
                runtimeId: sourceRuntimeId,
              });
            } else {
              const blockEnvelope = toBlockEnvelope(block, { turnId, sessionId, requestId, traceId });
              await store.addMessage(sessionId, "assistant", "", { turnId, block: blockEnvelope });
              await emit("block.emitted", turnId, traceId, { block: blockEnvelope });
            }
          }

          // Emit state patches
          for (const proposal of turnResult.proposals) {
            for (const item of proposal.items) {
              if (item.kind === "state.patch") {
                const patchRecord = {
                  id: createStatePatchId(turnId, seq),
                  summary: `${proposal.pluginId} state update`,
                  packageName: proposal.pluginId,
                  data: item.payload,
                };
                await store.addStatePatch(sessionId, patchRecord);
                await emit("state.patch.applied", turnId, traceId, {
                  patch: { ...patchRecord, target: "state" },
                });
              }
            }
          }

          // Emit state snapshot for client-side persistence (retry path)
          if (turnResult.stateSnapshot) {
            await emit("state.snapshot", turnId, traceId, {
              state: turnResult.stateSnapshot.state,
              events: turnResult.stateSnapshot.events,
              records: turnResult.stateSnapshot.records,
            });
            // Persist server-side for T3 and session resume
            await store.saveStateSnapshot(sessionId, {
              state: turnResult.stateSnapshot.state,
              events: turnResult.stateSnapshot.events,
              records: turnResult.stateSnapshot.records,
            });
          }

          backgroundTaskCount = turnResult.backgroundTasks?.length ?? 0;
          if (backgroundTaskCount === 0) resolveBackgroundDone?.();
          if (backgroundTaskCount > 0) {
            await emit("flow.phase.changed", turnId, traceId, { phase: "background" });
            await backgroundDonePromise;
          }

          await emit("flow.completed", turnId, traceId, { flowId, retry: true, retryFromRuntimeId: retryRuntimeId ?? null });
          return;
        }

        // ── start_session / send_message / submit_block_response → kernel turn
        const runInfo = getRunInfo(sessionId);
        const userContent = (payload.content ?? "") as string;

        // Determine input type
        let inputType: string;
        if (type === "start_session") {
          inputType = "session_start";
        } else {
          inputType = "user.input";
        }

        // Store user message (not for start_session — no user content)
        if (userContent && type === "send_message") {
          await store.addMessage(sessionId, "user", userContent);
        }

        // Resolve per-session kernel session
        const kernelSession = getOrCreateSession(sessionId);

        // Build kernel context from session state
        const chatHistory = (await store.listMessages(sessionId)).map((m) => ({
          role: m.role,
          content: m.content,
        }));
        const world = await store.getWorld(session.worldId);
        const rawLoreOverride = payload?.loreOverride;
        const loreOverride = typeof rawLoreOverride === "string" && rawLoreOverride.length <= 50000
          ? rawLoreOverride
          : undefined;

        // Load persisted state snapshot for kernel context rehydration
        const stateSnapshot = await store.getStateSnapshot(sessionId);

        kernelSession.setContext({
          world: world
            ? {
                name: world.name,
                description: world.description,
                ...(loreOverride || world.lore
                  ? { lore: loreOverride ?? world.lore }
                  : {}),
                ...(world.dimensions ? { dimensions: world.dimensions } : {}),
              }
            : undefined,
          chat: chatHistory,
          ...(stateSnapshot
          ? { state: ((stateSnapshot as Record<string, unknown>).state ?? stateSnapshot) as Record<string, unknown> }
          : {}),
        });

        // Provisional IDs for progress events emitted before turn completes
        const provTurnId = `turn_${Date.now().toString(36)}`;
        const provTraceId = `trace_${Date.now().toString(36)}`;

        await emit("flow.phase.changed", provTurnId, provTraceId, { phase: "model" });

        // Track which runtimes had their narrative streamed via message.delta
        const streamedRuntimeIds = new Set<string>();
        // Track runtime kind (e.g. "story", "plugin") for message metadata
        const runtimeKindMap = new Map<string, string>();

        // Track background task completion for SSE streaming.
        // Resolved when all background tasks finish (or immediately if none).
        let resolveBackgroundDone: (() => void) | undefined;
        let backgroundTaskCount = 0;
        let backgroundTaskDoneCount = 0;
        const backgroundDonePromise = new Promise<void>((resolve) => {
          resolveBackgroundDone = resolve;
        });

        // Execute kernel turn with progress callback for real-time SSE
        let mainTurnResult: KernelTurnResult | undefined;
        mainTurnResult = await kernelSession.executeTurn(
          {
            runId: runInfo.runId,
            branchId: runInfo.branchId,
            actorId: "player",
            type: inputType,
            locale: locale ?? "zh-CN",
            payload: type === "submit_block_response" ? payload : { text: userContent },
          },
          {
            apiKeys,
            slotOverrides,
            runtimePriorityOverrides,
            onProgress: async (evt) => {
              if (evt.type === "message.delta") {
                streamedRuntimeIds.add(evt.runtimeId);
                await emit("message.delta", provTurnId, provTraceId, {
                  runtimeId: evt.runtimeId,
                  pluginId: evt.pluginId,
                  delta: evt.detail ?? "",
                });
              } else {
                // Track runtime kind from runtime.started label (format: "pluginId/kind")
                if (evt.type === "runtime.started" && evt.label) {
                  const slashIdx = evt.label.indexOf("/");
                  if (slashIdx >= 0) {
                    runtimeKindMap.set(evt.runtimeId, evt.label.slice(slashIdx + 1));
                  }
                }
                await emit("runtime.progress", provTurnId, provTraceId, { ...evt });
              }
            },
            onBackgroundTaskDone: async (task) => {
              if (!mainTurnResult) {
                console.warn("[actions] onBackgroundTaskDone fired before executeTurn resolved");
                backgroundTaskDoneCount++;
                if (backgroundTaskDoneCount >= backgroundTaskCount) {
                  resolveBackgroundDone?.();
                }
                return;
              }
              const { turnId: tid, traceId: trid } = mainTurnResult;
              try {
                if (task.status === "completed" && task.result) {
                  // Emit narrative from background runtime
                  if (task.result.text) {
                    await store.addMessage(sessionId, "assistant", task.result.text, { turnId: tid, runtimeId: task.runtimeId });
                    const msgId = `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
                    await emit("message.completed", tid, trid, {
                      messageId: msgId,
                      content: task.result.text,
                      background: true,
                      runtimeId: task.runtimeId,
                      pluginId: task.pluginId,
                    });
                  }
                  // Emit state patches from background proposals
                  for (const item of task.result.proposals) {
                    if (item.kind === "state.patch") {
                      const patchRecord = {
                        id: createStatePatchId(tid, seq),
                        summary: `${task.pluginId} background state update`,
                        packageName: task.pluginId,
                        data: item.payload,
                      };
                      await store.addStatePatch(sessionId, patchRecord);
                      await emit("state.patch.applied", tid, trid, {
                        patch: { ...patchRecord, target: "state" },
                      });
                    } else if (item.kind === "ui.render") {
                      const payload = item.payload as { type: string; content: unknown };
                      const blockEnvelope = toBlockEnvelope(
                        {
                          type: payload.type,
                          content: payload.content,
                          source: { runtimeId: task.runtimeId, pluginId: task.pluginId },
                        },
                        { turnId: tid, sessionId, requestId, traceId: trid }
                      );
                      await store.addMessage(sessionId, "assistant", "", { turnId: tid, block: blockEnvelope });
                      await emit("block.emitted", tid, trid, { block: blockEnvelope });
                    }
                  }
                } else if (task.status === "failed") {
                  console.warn(`[actions] Background task failed: ${task.runtimeId}`, task.error);
                  await emit("runtime.progress", tid, trid, {
                    type: "runtime.failed",
                    runtimeId: task.runtimeId,
                    pluginId: task.pluginId,
                    label: `${task.pluginId}/background`,
                    detail: task.error ?? "Unknown error",
                  });
                }
              } finally {
                backgroundTaskDoneCount++;
                if (backgroundTaskDoneCount >= backgroundTaskCount) {
                  resolveBackgroundDone?.();
                }
              }
            },
          }
        );
        const turnResult = mainTurnResult;

        const { turnId, traceId } = turnResult;

        // Build a list of runtimeIds for each narrative block by scanning proposals.
        // The commit-service appends narrative.append items in proposal order,
        // which matches the order of narrative blocks in turnResult.render.blocks.
        const narrativeSourceRuntimeIds: string[] = [];
        for (const proposal of turnResult.proposals) {
          for (const item of proposal.items) {
            if (item.kind === "narrative.append") {
              narrativeSourceRuntimeIds.push(proposal.runtimeId);
            }
          }
        }

        // Emit render blocks as SSE events
        let narrativeIndex = 0;
        for (const block of turnResult.render.blocks) {
          if (block.type === "narrative") {
            // Check if THIS specific runtime's narrative was already streamed via message.delta.
            // Only suppress message.completed for runtimes that streamed their content.
            const sourceRuntimeId = block.source?.runtimeId
              ?? narrativeSourceRuntimeIds[narrativeIndex]
              ?? "";
            narrativeIndex++;
            const narrativeKind = runtimeKindMap.get(sourceRuntimeId);
            await store.addMessage(sessionId, "assistant", block.content as string, { turnId, runtimeId: sourceRuntimeId, kind: narrativeKind });
            // Always emit message.completed with runtimeId so the frontend can persist
            // to IndexedDB. The frontend deduplicates streamed vs completed messages
            // in the reducer, but IDB persistence only happens in this handler.
            const msgId = `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
            await emit("message.completed", turnId, traceId, {
              messageId: msgId,
              content: block.content,
              runtimeId: sourceRuntimeId,
            });
          } else {
            const blockEnvelope = toBlockEnvelope(block, {
              turnId,
              sessionId,
              requestId,
              traceId,
            });
            await store.addMessage(sessionId, "assistant", "", { turnId, block: blockEnvelope });
            await emit("block.emitted", turnId, traceId, { block: blockEnvelope });
          }
        }

        // Emit state patches
        for (const proposal of turnResult.proposals) {
          for (const item of proposal.items) {
            if (item.kind === "state.patch") {
              const patchRecord = {
                id: createStatePatchId(turnId, seq),
                summary: `${proposal.pluginId} state update`,
                packageName: proposal.pluginId,
                data: item.payload,
              };
              await store.addStatePatch(sessionId, patchRecord);
              await emit("state.patch.applied", turnId, traceId, {
                patch: { ...patchRecord, target: "state" },
              });
            }
          }
        }

        // Emit state snapshot for client-side persistence (T1/T2)
        if (turnResult.stateSnapshot) {
          await emit("state.snapshot", turnId, traceId, {
            state: turnResult.stateSnapshot.state,
            events: turnResult.stateSnapshot.events,
            records: turnResult.stateSnapshot.records,
          });
          // Persist server-side for T3 and session resume
          await store.saveStateSnapshot(sessionId, {
            state: turnResult.stateSnapshot.state,
            events: turnResult.stateSnapshot.events,
            records: turnResult.stateSnapshot.records,
          });
        }

        // Phase transitions
        const hasCharCreationBlock = turnResult.render.blocks.some(
          (b) => b.type === "character_creation"
        );

        if (type === "start_session" && hasCharCreationBlock) {
          await store.updateSessionPhase(sessionId, "character_creation");
          await emit("phase_change", turnId, traceId, { phase: "character_creation" });
        } else if (type === "submit_block_response") {
          const currentSession = await store.getSession(sessionId);
          if (currentSession?.phase === "character_creation") {
            await store.updateSessionPhase(sessionId, "playing");
            await emit("phase_change", turnId, traceId, { phase: "playing" });
          }
        }

        // Wait for background tasks to complete before closing the stream
        backgroundTaskCount = turnResult.backgroundTasks?.length ?? 0;
        if (backgroundTaskCount === 0) {
          // No background tasks — resolve immediately
          resolveBackgroundDone?.();
        }
        if (backgroundTaskCount > 0) {
          await emit("flow.phase.changed", turnId, traceId, { phase: "background" });
          await backgroundDonePromise;
        }

        // flow.completed
        await emit("flow.completed", turnId, traceId, { flowId });
      } catch (err: unknown) {
        const rawMsg = err instanceof Error ? err.message : "Internal error";
        console.error("[actions] Error:", err);
        const tier = process.env.DEPLOYMENT_TIER ?? "self";
        const msg = tier === "self" ? rawMsg : "An internal error occurred";
        await emit("flow.failed", "", "", { code: "EXECUTION_ERROR", message: msg });
      } finally {
        // Clean up ephemeral custom presets
        if (registeredCustomIds.length > 0 && deps.presetRegistry) {
          for (const id of registeredCustomIds) {
            deps.presetRegistry.removePreset(id);
          }
        }
      }
    });
  });

  return route;
}
