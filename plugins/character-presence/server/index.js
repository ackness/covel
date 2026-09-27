export default function (covel) {
  covel.provideExtension("ui.slot@1", "visuals", {
    async handler({ previous }, ctx) {
      const rows = await ctx.pluginData.list("presence");
      const characters = new Map(
        (previous?.characters ?? []).map((value) => [value.characterId, value]),
      );
      for (const row of rows) {
        const record = row.value;
        if (!record || typeof record.characterId !== "string") continue;
        const canonical = ctx.world.characters.find(
          (character) =>
            character.id === record.characterId ||
            character.id.endsWith(`-${record.characterId}`),
        );
        const characterId = canonical?.id ?? record.characterId;
        const value = {
          characterId,
          ...(record.displayName || canonical?.name
            ? { displayName: record.displayName ?? canonical.name }
            : {}),
          ...(record.avatar ? { avatar: record.avatar } : {}),
          ...(record.sprite ? { sprite: record.sprite } : {}),
          ...(record.visuals ? { visuals: record.visuals } : {}),
        };
        characters.set(characterId, {
          ...characters.get(characterId),
          ...value,
        });
      }
      return { characters: [...characters.values()] };
    },
  });
}
