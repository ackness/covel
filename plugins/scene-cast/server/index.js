export default function (covel) {
  covel.provideExtension("ui.slot@1", "cast", {
    async handler(_input, ctx) {
      const current = (await ctx.pluginData.get("active-cast", "current"))
        ?.value;
      return {
        actors: (current?.speakers ?? []).map((speaker, index) => ({
          characterId: speaker.id,
          displayName: speaker.name,
          active: index === 0,
          ...(speaker.type ? { type: speaker.type } : {}),
          ...(speaker.description ? { description: speaker.description } : {}),
        })),
        retainWhenEmpty: true,
      };
    },
  });
}
