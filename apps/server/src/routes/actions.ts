import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Kernel } from "@covel/kernel";
import type { CommandBus } from "@covel/plugin-runtime";
import type { KernelTurnResult, RenderBlock } from "@covel/shared";
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
  kernel: Kernel;
  commandBus: CommandBus;
  store: MemoryStore;
}) {
  const { kernel, commandBus, store } = deps;

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

  const route = new Hono();

  route.post("/", async (c) => {
    const body = await c.req.json<{
      requestId: string;
      type: "send_message" | "execute_command" | "submit_block_response" | "start_session";
      sessionId: string;
      locale?: string;
      payload: Record<string, unknown>;
    }>();

    const { requestId, type, sessionId, locale, payload } = body;

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

    const apiKeys = ((c as any).get("apiKeys") as Record<string, string>) ?? {};

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

        // Build kernel context from session state
        const chatHistory = store.listMessages(sessionId).map((m) => ({
          role: m.role,
          content: m.content,
        }));
        const world = store.getWorld(session.worldId);

        kernel.setContext({
          world: world
            ? {
                name: world.name,
                description: world.description,
                ...(world.lore ? { lore: world.lore } : {}),
              }
            : undefined,
          chat: chatHistory,
        });

        // Execute kernel turn
        const turnResult = await kernel.executeTurn(
          {
            runId: runInfo.runId,
            branchId: runInfo.branchId,
            actorId: "player",
            type: inputType,
            locale: locale ?? "zh-CN",
            payload: type === "submit_block_response" ? payload : { text: userContent },
          },
          { apiKeys }
        );

        const { turnId, traceId } = turnResult;

        // Emit phase
        await emit("flow.phase.changed", turnId, traceId, { phase: "model" });

        // Emit render blocks as SSE events
        for (const block of turnResult.render.blocks) {
          if (block.type === "narrative") {
            const msgId = `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
            store.addMessage(sessionId, "assistant", block.content as string);
            await emit("message.completed", turnId, traceId, {
              messageId: msgId,
              content: block.content,
            });
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

        // flow.completed
        await emit("flow.completed", turnId, traceId, { flowId });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal error";
        console.error("[actions] Error:", err);
        await emit("flow.failed", "", "", { code: "EXECUTION_ERROR", message: msg });
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
