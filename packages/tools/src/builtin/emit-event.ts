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
    description:
      "Emit a domain event declared by an active plugin (see the advertised event directory in your context). One topic per call.",
    parameters: z.object({
      topic: z.string(),
      data: z.record(z.string(), z.unknown()).default({}),
    }),
    execute: async ({ topic, data }, context) => {
      if (context.emittedEventTopics?.includes(topic)) {
        return {
          _text: `event "${topic}" already emitted this turn — skipped`,
        };
      }
      const known = await deps.directory.listTopics(context.sessionId);
      if (!known.includes(topic)) {
        return {
          _text: `unknown topic "${topic}". Available topics: ${known.join(", ") || "(none — no consumer plugin active)"}`,
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
      return withEmittedEvents({ _text: `event "${topic}" emitted` }, [
        { topic, data },
      ]);
    },
  });
}
