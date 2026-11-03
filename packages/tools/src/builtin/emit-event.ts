/**
 * Built-in emit-event tool — lets an agent runtime emit a domain event
 * declared by an active consumer plugin's `events` manifest contract.
 *
 * Validation and topic listing are delegated to an injected directory
 * (server-side session event directory, see event-directory.ts) so
 * @covel/tools stays free of a runtime dependency on @covel/plugin-loader.
 *
 * Emitted events flow through the `emittedEvents` result channel
 * (see result.ts) — never as an `event.emit` pendingProposal — so the
 * tool loop / finalize merge into `output.events` exactly once.
 */

import { z } from "zod";
import { withModelView, ToolError, tool } from "@covel/plugin-handlers-utils";
import { withEmittedEvents } from "../result.js";
import type { ToolModule } from "../types.js";
import { modelToolSchema } from "../model-tool-schema.js";

/** Structural dep — implemented by the server's session event directory. */
export interface EventDirectoryLike {
  listTopics(sessionId: string): Promise<readonly string[]>;
  describeTopics?(
    sessionId: string,
  ): Promise<readonly { topic: string; schema?: Record<string, unknown> }[]>;
  validate(
    sessionId: string,
    topic: string,
    data: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export function createEmitEventTool(deps: {
  directory: EventDirectoryLike;
}): ToolModule {
  return tool({
    name: "emit-event",
    description: "Emit one advertised domain-event topic.",
    parameters: z.object({
      topic: z.string(),
      data: z.record(z.string(), z.unknown()).default({}),
    }),
    execute: async ({ topic, data }, context) => {
      if (context.emittedEventTopics?.includes(topic)) {
        // Say what to do next: a model that reads only "skipped" tries again.
        return withModelView(
          {},
          {
            summary: `event "${topic}" was already emitted this turn and is recorded. Do not emit it again; continue with the task.`,
          },
        );
      }
      const known = await deps.directory.listTopics(context.sessionId);
      if (!known.includes(topic)) {
        // Thrown, so the call counts as failed: a refused emit must not
        // satisfy `requireToolUse` or a finishing-tool rule. A refusal and
        // not an error: the model can correct nothing here, and a runtime
        // that goes on to finish has not failed.
        throw new ToolError(
          "refused",
          `unknown topic "${topic}"; no active plugin consumes it, so it cannot be emitted. Do not retry it. Available topics: ${known.join(", ") || "(none — no consumer plugin active)"}`,
        );
      }
      const verdict = await deps.directory.validate(
        context.sessionId,
        topic,
        data,
      );
      if (!verdict.ok) {
        throw new ToolError(
          "invalid-input",
          `event payload rejected: ${verdict.reason}`,
        );
      }
      // One topic is emitted one time in a turn. The result says so: with a
      // bare "emitted" some models send the same event again to be sure.
      return withEmittedEvents(
        withModelView(
          {},
          {
            summary: `event "${topic}" emitted and recorded for this turn. Do not emit it again.`,
          },
        ),
        [{ topic, data }],
      );
    },
  });
}

/** The payload shape the emit-event tool can show a model, if any. */
function describedPayload(
  schema: Record<string, unknown> | undefined,
): Readonly<Record<string, unknown>> {
  if (!schema) throw new Error("schema unavailable");
  const payload = modelToolSchema(schema);
  if (payload.type !== "object")
    throw new Error("payload must describe an object");
  return payload;
}

/**
 * Whether the emit-event tool can describe this payload. The prompt's event
 * catalogue repeats only the schemas the tool cannot show.
 */
export function canDescribeEventPayload(schema: unknown): boolean {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema))
    return false;
  try {
    describedPayload(schema as Record<string, unknown>);
    return true;
  } catch {
    return false;
  }
}

/** Advertise payload shapes without tightening the execution-time topic gate. */
export function buildSessionEmitEventTool(
  deps: { directory: EventDirectoryLike },
  topics: readonly { topic: string; schema?: Record<string, unknown> }[],
): ToolModule | undefined {
  if (topics.length === 0) return undefined;
  const base = createEmitEventTool(deps);
  const described = topics.flatMap(({ topic, schema }) => {
    try {
      const payload = describedPayload(schema);
      return [{ topic, payload: { ...payload, title: topic } }];
    } catch (error) {
      console.warn(
        `[emit-event] topic "${topic}" omitted from model tool schema: ${error instanceof Error ? error.message : "schema cannot be described"}`,
      );
      return [];
    }
  });
  if (described.length === 0) return undefined;
  const payloads = described.map(({ payload }) => payload);
  return {
    ...base,
    jsonSchema: {
      type: "object",
      properties: {
        topic: { type: "string", enum: described.map(({ topic }) => topic) },
        data:
          payloads.length === 1
            ? payloads[0]
            : { type: "object", anyOf: payloads },
      },
      required: ["topic", "data"],
    },
  };
}
