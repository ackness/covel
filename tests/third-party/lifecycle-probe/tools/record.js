export default function ({ tool, z, withPendingProposals }) {
  return tool({
    name: "lifecycle-probe-record",
    description: "Record a synthetic note in this plugin's own namespace.",
    parameters: z.object({ key: z.string().min(1), text: z.string().min(1) }),
    async execute(args, ctx) {
      const note = {
        kind: "agent",
        text: args.text,
        label: "fixture",
        count: 1,
      };
      return withPendingProposals({ recorded: true }, [
        {
          id: crypto.randomUUID(),
          type: "plugin.data",
          source: { pluginId: ctx.pluginId, runtimeId: ctx.runtimeId },
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          payload: { namespace: "notes", key: args.key, value: note },
          timestamp: new Date().toISOString(),
        },
      ]);
    },
  });
}
