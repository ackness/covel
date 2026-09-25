export default async function handler(ctx) {
  const choices = ctx.inputs.choices;
  const result = await ctx.services.call({
    pluginId: ctx.pluginId,
    name: "evaluate",
    contract: "test/evaluation@1",
    input: {
      state: { narrative: ctx.inputs.narrative.value },
      options: choices.value.prompts.map((prompt, index) => ({
        id: `prompt:${index + 1}`,
        text: prompt.text,
      })),
    },
  });
  const value = {
    turnId: ctx.turnId,
    source: choices.source,
    status: "ready",
    ...result,
  };
  return {
    outcome: "success",
    value,
    effects: {
      pluginData: [{ namespace: "recommendations", key: "current", value }],
    },
  };
}
