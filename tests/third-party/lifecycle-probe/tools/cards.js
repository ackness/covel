export default function ({ tool, z, withPendingProposals }) {
  return tool({
    name: "lifecycle-probe-cards",
    description: "Publish a message card anchored to the supplied story.",
    parameters: z.object({ text: z.string().min(1) }),
    execute: async ({ text }, ctx) =>
      withPendingProposals({ published: true }, [
        {
          id: crypto.randomUUID(),
          type: "plugin.data.batch",
          source: { pluginId: ctx.pluginId, runtimeId: ctx.runtimeId },
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          timestamp: new Date().toISOString(),
          payload: {
            items: [
              { namespace: "message", key: "__turnId", value: ctx.turnId },
              { namespace: "message", key: "prompt1Text", value: text },
              { namespace: "message", key: "prompt1Label", value: "Inspect" },
              {
                namespace: "message",
                key: "recap",
                value: ctx.inputSlots?.narrative?.value ?? "",
              },
            ],
          },
        },
      ]),
  });
}
