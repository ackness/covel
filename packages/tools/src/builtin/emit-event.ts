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

/** Advertise payload shapes without tightening the execution-time topic gate. */
export function buildSessionEmitEventTool(
  deps: { directory: EventDirectoryLike },
  topics: readonly { topic: string; schema?: Record<string, unknown> }[],
): ToolModule | undefined {
  if (topics.length === 0) return undefined;
  const base = createEmitEventTool(deps);
  const payloads = topics.map(({ topic, schema }) => {
    // References may be nested; never send a provider a dangling reference.
    const hasReferences = (value: unknown): boolean => {
      if (value === null || typeof value !== "object") return false;
      return Object.entries(value).some(
        ([key, child]) =>
          key === "$ref" || key === "$defs" || hasReferences(child),
      );
    };
    if (!schema || hasReferences(schema))
      return { type: "object", title: topic };
    const { $schema: _schema, $id: _id, ...payload } = schema;
    return { ...payload, title: topic };
  });
  return {
    ...base,
    jsonSchema: {
      type: "object",
      properties: {
        topic: { type: "string", enum: topics.map(({ topic }) => topic) },
        data: payloads.length === 1 ? payloads[0] : { anyOf: payloads },
      },
      required: ["topic", "data"],
    },
  };
}
