export default function (covel) {
  covel.provideExtension("ui.slot@1", "backdrop", {
    async handler({ previous, events }, ctx) {
      const current = (await ctx.pluginData.get("scenery_private", "current"))
        ?.value;
      if (!current) return previous;
      const preview = events.find(
        (event) => event.topic === "community-stage.preview",
      );
      return {
        name: preview ? String(preview.data.name) : current.name,
        pending: false,
        ...(current.ref ? { ref: current.ref } : {}),
      };
    },
  });
  covel.provideExtension("ui.slot@1", "cast", {
    async handler({ previous }, ctx) {
      const current = (await ctx.pluginData.get("cast_private", "current"))
        ?.value;
      return current ?? previous;
    },
  });
  covel.provideExtension("ui.slot@1", "portrait", {
    async handler({ previous }, ctx) {
      const rows = await ctx.pluginData.list("portraits_private");
      if (!rows.length) return previous;
      const characters = new Map(
        (previous?.characters ?? []).map((entry) => [entry.characterId, entry]),
      );
      for (const row of rows) {
        const visual = row.value;
        if (visual?.characterId) characters.set(visual.characterId, visual);
      }
      return { characters: [...characters.values()] };
    },
  });
}
