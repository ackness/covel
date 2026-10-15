/**
 * Plugin-local tool: record-note
 *
 * Persists one plugin-owned note through the proposal pipeline. The framework
 * injects tool, z, shortId, and withPendingProposals. The public SDK builds
 * the proposal envelope.
 */
import { makeProposal } from "@covel/plugin-handlers-utils";

/** @param {import("@covel/plugin-handlers-utils/plugin-api").PluginToolkit} toolkit */
export default function ({ tool, z, shortId, withPendingProposals }) {
  return tool({
    name: "record-note",
    description:
      "Record one structured note that serves this plugin's purpose. Call it only when the narrative gives new information worth reusing.",
    parameters: z.object({
      title: z.string().min(1).max(80).describe("Short title"),
      text: z
        .string()
        .min(1)
        .max(500)
        .describe("The note itself, one or two concrete sentences"),
      tags: z
        .array(z.string().min(1))
        .max(5)
        .default([])
        .describe("Category tags"),
    }),
    execute: async (params, context) => {
      const key = shortId(
        "note",
        params.title,
        context.sessionId,
        context.random,
      );
      const now = new Date().toISOString();
      const note = {
        kind: "note",
        title: params.title,
        text: params.text,
        tags: params.tags,
        turnId: context.turnId,
        createdAt: now,
      };

      return withPendingProposals({ recorded: true, key, note }, [
        makeProposal(context, now, "plugin.data", {
          namespace: "notes",
          key,
          value: note,
        }),
      ]);
    },
  });
}
