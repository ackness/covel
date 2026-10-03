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
import { tool } from "../tool.js";
import { withEmittedEvents } from "../result.js";
import type { ToolModule } from "../types.js";

/** Structural dep — implemented by the server's session event directory. */
export interface EventDirectoryLike {
  listTopics(sessionId: string): Promise<readonly string[]>;
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
        return {
          // Say what to do next: a model that reads only "skipped" tries a
          // third time.
          _text: `event "${topic}" was already emitted this turn and is recorded. Do not emit it again; continue with the task.`,
        };
      }
      const known = await deps.directory.listTopics(context.sessionId);
      if (!known.includes(topic)) {
        return {
          _text: `unknown topic "${topic}"; no active plugin consumes it, so it cannot be emitted. Do not retry it. Available topics: ${known.join(", ") || "(none — no consumer plugin active)"}`,
        };
      }
      const verdict = await deps.directory.validate(
        context.sessionId,
        topic,
        data,
      );
      if (!verdict.ok) {
        return { _text: `event payload rejected: ${verdict.reason}` };
      }
      // One topic is emitted one time in a turn. The result says so: with a
      // bare "emitted" some models send the same event again to be sure.
      return withEmittedEvents(
        {
          _text: `event "${topic}" emitted and recorded for this turn. Do not emit it again.`,
        },
        [{ topic, data }],
      );
    },
  });
}
