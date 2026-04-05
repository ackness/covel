import type { ToolExecutionContext, ToolExecutionResult } from "@covel/shared";
import { z } from "zod";
import {
  createEvent,
  evolveEvent,
  resolveEvent,
  endEvent,
  EMPTY_STATE,
  type EventState,
} from "./event-logic.js";

// ── Zod Schemas ─────────────────────────────────────────────────

const createEventInputSchema = z.object({
  eventType: z.enum(["quest", "combat", "social", "world", "system"]),
  name: z.string(),
  description: z.string(),
  source: z.string(),
  parentEventId: z.string().optional(),
  visibility: z.enum(["known", "hidden", "secret"]).optional(),
});

const evolveEventInputSchema = z.object({
  eventId: z.string(),
  description: z.string(),
});

const resolveEventInputSchema = z.object({
  eventId: z.string(),
  resolution: z.string().optional(),
});

const endEventInputSchema = z.object({
  eventId: z.string(),
  reason: z.string().optional(),
});

// ── Helpers ───────────────────────────────────────────────────────

function extractEventState(
  state: Record<string, unknown> | undefined,
): EventState {
  if (state && typeof state === "object") {
    const eventState = state["core-event"];
    if (
      eventState &&
      typeof eventState === "object" &&
      Array.isArray((eventState as Record<string, unknown>).events)
    ) {
      return eventState as unknown as EventState;
    }
  }
  return EMPTY_STATE;
}

/**
 * Tool: create-event
 *
 * Creates a new game event. The LLM provides event data;
 * the tool generates an ID and emits proposals.
 */
export async function createEventTool(
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const parsed = createEventInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }
  const input = parsed.data;

  const currentState = extractEventState(ctx.state);

  try {
    const result = createEvent(currentState, {
      eventType: input.eventType,
      name: input.name,
      description: input.description,
      source: input.source,
      parentEventId: input.parentEventId,
      visibility: input.visibility,
    });

    return {
      output: {
        message: isZh
          ? `已创建事件「${result.event.name}」(${result.event.eventId})。`
          : `Created event "${result.event.name}" (${result.event.eventId}).`,
        eventId: result.event.eventId,
      },
      proposals: [
        {
          kind: "state.patch",
          payload: {
            "core-event": { events: result.state.events },
          },
        },
        {
          kind: "record.upsert",
          payload: {
            key: `event:${result.event.eventId}`,
            recordType: "event",
            value: result.event,
          },
        },
        {
          kind: "event.emit",
          payload: {
            type: "game_event_created",
            eventId: result.event.eventId,
            eventName: result.event.name,
            eventType: result.event.eventType,
          },
        },
      ],
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return { output: { error: msg } };
  }
}

/**
 * Tool: evolve-event
 *
 * Evolves an existing event with a new description.
 */
export async function evolveEventTool(
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const parsed = evolveEventInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }
  const input = parsed.data;

  const currentState = extractEventState(ctx.state);

  try {
    const newState = evolveEvent(currentState, input.eventId, input.description);
    const updatedEvent = newState.events.find(
      (e) => e.eventId === input.eventId,
    )!;

    return {
      output: {
        message: isZh
          ? `事件 ${input.eventId} 已演变。`
          : `Event ${input.eventId} evolved.`,
        eventId: input.eventId,
      },
      proposals: [
        {
          kind: "state.patch",
          payload: {
            "core-event": { events: newState.events },
          },
        },
        {
          kind: "record.upsert",
          payload: {
            key: `event:${input.eventId}`,
            recordType: "event",
            value: updatedEvent,
          },
        },
      ],
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return { output: { error: msg } };
  }
}

/**
 * Tool: resolve-event
 *
 * Resolves an event, marking it as completed/resolved.
 */
export async function resolveEventTool(
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const parsed = resolveEventInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }
  const input = parsed.data;

  const currentState = extractEventState(ctx.state);

  try {
    const newState = resolveEvent(
      currentState,
      input.eventId,
      input.resolution,
    );
    const updatedEvent = newState.events.find(
      (e) => e.eventId === input.eventId,
    )!;

    return {
      output: {
        message: isZh
          ? `事件 ${input.eventId} 已解决。`
          : `Event ${input.eventId} resolved.`,
        eventId: input.eventId,
      },
      proposals: [
        {
          kind: "state.patch",
          payload: {
            "core-event": { events: newState.events },
          },
        },
        {
          kind: "record.upsert",
          payload: {
            key: `event:${input.eventId}`,
            recordType: "event",
            value: updatedEvent,
          },
        },
        {
          kind: "event.emit",
          payload: {
            type: "game_event_resolved",
            eventId: input.eventId,
          },
        },
      ],
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return { output: { error: msg } };
  }
}

/**
 * Tool: end-event
 *
 * Ends an event, marking it as terminated.
 */
export async function endEventTool(
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const parsed = endEventInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }
  const input = parsed.data;

  const currentState = extractEventState(ctx.state);

  try {
    const newState = endEvent(currentState, input.eventId, input.reason);
    const updatedEvent = newState.events.find(
      (e) => e.eventId === input.eventId,
    )!;

    return {
      output: {
        message: isZh
          ? `事件 ${input.eventId} 已结束。`
          : `Event ${input.eventId} ended.`,
        eventId: input.eventId,
      },
      proposals: [
        {
          kind: "state.patch",
          payload: {
            "core-event": { events: newState.events },
          },
        },
        {
          kind: "record.upsert",
          payload: {
            key: `event:${input.eventId}`,
            recordType: "event",
            value: updatedEvent,
          },
        },
      ],
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return { output: { error: msg } };
  }
}
