import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { KernelSession } from "@covel/kernel";
import type { CommandBus } from "@covel/plugin-runtime";
import type { KernelTurnResult, RenderBlock } from "@covel/shared";
import type { ApiKeyEnv } from "../middleware/api-key-injection.js";
import type { MemoryStore } from "../store/memory-store.js";

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

export function createActionsRoute(deps: {
  getOrCreateSession: (sessionId: string) => KernelSession;
  commandBus: CommandBus;
  store: MemoryStore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  presetRegistry?: {
    addPreset: (preset: any) => void;
    removePreset: (id: string) => void;
  };
}) {
  const { getOrCreateSession, commandBus, store } = deps;

  // Per-session run tracking
  const sessionRuns = new Map<string, { runId: string; branchId: string }>();

  function getRunInfo(sessionId: string) {
    let info = sessionRuns.get(sessionId);
    if (!info) {
      info = { runId: `run-${sessionId}`, branchId: "branch-main" };
      sessionRuns.set(sessionId, info);
    }
    return info;
  }

  const route = new Hono<ApiKeyEnv>();

  route.post("/", async (c) => {
    const body = await c.req.json<{
      requestId: string;
      type: "send_message" | "execute_command" | "submit_block_response" | "start_session" | "retry_runtime";
      sessionId: string;
      locale?: string;
      payload: Record<string, unknown>;
    }>();

    const { requestId, type, sessionId, locale, payload = {} } = body;

    if (!requestId || !type || !sessionId) {
      return c.json(
        { code: "INVALID_REQUEST", message: "requestId, type, and sessionId are required" },
        400
      );
    }

    const session = store.getSession(sessionId);
    if (!session) {
      return c.json({ code: "SESSION_NOT_FOUND", message: "Session not found" }, 404);
    }

    const apiKeys = c.get("apiKeys") ?? {};

    // Parse X-Slot-Config header for per-request slot overrides and custom presets
    let slotOverrides: Record<string, { presetId: string }> | undefined;
    let customPresetDefs: Array<{
      id: string; name: string; provider: string;
      baseUrl: string; model: string; protocol?: string;
    }> | undefined;
    const slotConfigHeader = c.req.header("x-slot-config");
    if (slotConfigHeader) {
      try {
        const decoded = JSON.parse(atob(slotConfigHeader)) as {
          slots?: Record<string, { presetId: string }>;
          customPresets?: Array<{
            id: string; name: string; provider: string;
            baseUrl: string; model: string; protocol?: string;
          }>;
        };
        if (decoded.slots && Object.keys(decoded.slots).length > 0) {
          slotOverrides = decoded.slots;
        }
        if (decoded.customPresets && decoded.customPresets.length > 0) {
          customPresetDefs = decoded.customPresets;
        }
      } catch {
        // Invalid header, skip
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
        await stream.writeSSE({
          data: JSON.stringify(env),
          event: env.type,
          id: String(env.seq),
        });
      }

      // Register custom presets from frontend (ephemeral, for this request)
      const registeredCustomIds: string[] = [];
      if (customPresetDefs && deps.presetRegistry) {
        for (const def of customPresetDefs) {
          deps.presetRegistry.addPreset({
            id: def.id,
            name: def.name,
            provider: def.provider,
            model: def.model,
            baseUrl: def.baseUrl || undefined,
            protocol: def.protocol,
            tier: "heavy",
            supportedModes: ["text"],
            enabled: true,
          });
          registeredCustomIds.push(def.id);
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
                store.addMessage(sessionId, "assistant", result.content as string);
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
          const chatHistory = store.listMessages(sessionId).map((m) => ({
            role: m.role,
            content: m.content,
          }));
          const world = store.getWorld(session.worldId);
          kernelSession.setContext({
            world: world
              ? { name: world.name, description: world.description, ...(world.lore ? { lore: world.lore } : {}) }
              : undefined,
            chat: chatHistory,
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
          let resolveBackgroundDone: (() => void) | undefined;
          let backgroundTaskCount = 0;
          let backgroundTaskDoneCount = 0;
          const backgroundDonePromise = new Promise<void>((resolve) => {
            resolveBackgroundDone = resolve;
          });

          const turnResult = await kernelSession.retryTurn(retryRuntimeId, {
            apiKeys,
            slotOverrides,
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
                await emit("runtime.progress", provTurnId, provTraceId, { ...evt });
              }
            },
            onBackgroundTaskDone: async (task) => {
              try {
                const { turnId: tid, traceId: trid } = turnResult;
                if (task.status === "completed" && task.result?.text) {
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
              // For retry: emit all non-cached, non-streamed narrative
              if (!streamedRuntimeIds.has(sourceRuntimeId)) {
                store.addMessage(sessionId, "assistant", block.content as string);
                const msgId = `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
                await emit("message.completed", turnId, traceId, {
                  messageId: msgId,
                  content: block.content,
                  runtimeId: sourceRuntimeId,
                });
              }
            } else {
              const blockEnvelope = toBlockEnvelope(block, { turnId, sessionId, requestId, traceId });
              await emit("block.emitted", turnId, traceId, { block: blockEnvelope });
            }
          }

          // Emit state patches
          for (const proposal of turnResult.proposals) {
            for (const item of proposal.items) {
              if (item.kind === "state.patch") {
                await emit("state.patch.applied", turnId, traceId, {
                  patch: {
                    id: `patch_${seq}`,
                    target: "state",
                    summary: `${proposal.pluginId} state update`,
                    packageName: proposal.pluginId,
                    data: item.payload,
                  },
                });
              }
            }
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
          store.addMessage(sessionId, "user", userContent);
        }

        // Resolve per-session kernel session
        const kernelSession = getOrCreateSession(sessionId);

        // Build kernel context from session state
        const chatHistory = store.listMessages(sessionId).map((m) => ({
          role: m.role,
          content: m.content,
        }));
        const world = store.getWorld(session.worldId);
        const loreOverride = payload?.loreOverride as string | undefined;

        kernelSession.setContext({
          world: world
            ? {
                name: world.name,
                description: world.description,
                ...(loreOverride || world.lore
                  ? { lore: loreOverride ?? world.lore }
                  : {}),
              }
            : undefined,
          chat: chatHistory,
        });

        // Provisional IDs for progress events emitted before turn completes
        const provTurnId = `turn_${Date.now().toString(36)}`;
        const provTraceId = `trace_${Date.now().toString(36)}`;

        await emit("flow.phase.changed", provTurnId, provTraceId, { phase: "model" });

        // Track which runtimes had their narrative streamed via message.delta
        const streamedRuntimeIds = new Set<string>();

        // Track background task completion for SSE streaming.
        // Resolved when all background tasks finish (or immediately if none).
        let resolveBackgroundDone: (() => void) | undefined;
        let backgroundTaskCount = 0;
        let backgroundTaskDoneCount = 0;
        const backgroundDonePromise = new Promise<void>((resolve) => {
          resolveBackgroundDone = resolve;
        });

        // Execute kernel turn with progress callback for real-time SSE
        const turnResult = await kernelSession.executeTurn(
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
            onProgress: async (evt) => {
              if (evt.type === "message.delta") {
                streamedRuntimeIds.add(evt.runtimeId);
                await emit("message.delta", provTurnId, provTraceId, {
                  runtimeId: evt.runtimeId,
                  pluginId: evt.pluginId,
                  delta: evt.detail ?? "",
                });
              } else {
                await emit("runtime.progress", provTurnId, provTraceId, { ...evt });
              }
            },
            onBackgroundTaskDone: async (task) => {
              const { turnId: tid, traceId: trid } = turnResult;
              try {
                if (task.status === "completed" && task.result) {
                  // Emit narrative from background runtime
                  if (task.result.text) {
                    store.addMessage(sessionId, "assistant", task.result.text);
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
                      await emit("state.patch.applied", tid, trid, {
                        patch: {
                          id: `patch_${seq}`,
                          target: "state",
                          summary: `${task.pluginId} background state update`,
                          packageName: task.pluginId,
                          data: item.payload,
                        },
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
            store.addMessage(sessionId, "assistant", block.content as string);
            // Check if THIS specific runtime's narrative was already streamed via message.delta.
            // Only suppress message.completed for runtimes that streamed their content.
            const sourceRuntimeId = block.source?.runtimeId
              ?? narrativeSourceRuntimeIds[narrativeIndex]
              ?? "";
            narrativeIndex++;
            if (!streamedRuntimeIds.has(sourceRuntimeId)) {
              const msgId = `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
              await emit("message.completed", turnId, traceId, {
                messageId: msgId,
                content: block.content,
              });
            }
          } else {
            const blockEnvelope = toBlockEnvelope(block, {
              turnId,
              sessionId,
              requestId,
              traceId,
            });
            await emit("block.emitted", turnId, traceId, { block: blockEnvelope });
          }
        }

        // Emit state patches
        for (const proposal of turnResult.proposals) {
          for (const item of proposal.items) {
            if (item.kind === "state.patch") {
              await emit("state.patch.applied", turnId, traceId, {
                patch: {
                  id: `patch_${seq}`,
                  target: "state",
                  summary: `${proposal.pluginId} state update`,
                  packageName: proposal.pluginId,
                  data: item.payload,
                },
              });
            }
          }
        }

        // Phase transitions
        const hasCharCreationBlock = turnResult.render.blocks.some(
          (b) => b.type === "character_creation"
        );

        if (type === "start_session" && hasCharCreationBlock) {
          store.updateSessionPhase(sessionId, "character_creation");
          await emit("phase_change", turnId, traceId, { phase: "character_creation" });
        } else if (type === "submit_block_response") {
          const currentSession = store.getSession(sessionId);
          if (currentSession?.phase === "character_creation") {
            store.updateSessionPhase(sessionId, "playing");
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
        const msg = err instanceof Error ? err.message : "Internal error";
        console.error("[actions] Error:", err);
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

// ── Helpers ─────────────────────────────────────────────────────────

function toBlockEnvelope(
  block: RenderBlock,
  meta: { turnId: string; sessionId: string; requestId: string; traceId: string }
) {
  let blockType = block.type;
  if (blockType === "choices") blockType = "choice_set";

  const data = normalizeBlockData(block);
  // Block types that require player response
  const INTERACTIVE_BLOCK_TYPES = new Set(["choice_set", "character_creation"]);
  const isInteractive = INTERACTIVE_BLOCK_TYPES.has(blockType);

  return {
    id: `block_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    type: blockType,
    version: "1.0",
    meta: {
      package: block.source?.pluginId ?? "kernel",
      requestId: meta.requestId,
      traceId: meta.traceId,
      sessionId: meta.sessionId,
      turnId: meta.turnId,
    },
    interaction: {
      requiresResponse: isInteractive,
      ...(isInteractive
        ? { responseSchema: "inline", submitAs: "block_response", resumePolicy: "continue" }
        : {}),
    },
    data,
  };
}

function normalizeBlockData(block: RenderBlock): Record<string, unknown> {
  const content = block.content as Record<string, unknown> | undefined;
  if (!content) return {};

  // Flatten nested content: { type: "choices", content: { title, options } } → { title, options }
  if (content.content && typeof content.content === "object") {
    return content.content as Record<string, unknown>;
  }

  return content;
}
