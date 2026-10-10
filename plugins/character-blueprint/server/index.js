import { roleplayNoteSegments } from "../lib/roleplay-notes.js";

export default function (covel) {
  // The cards hold how the author wants each character played. The cast
  // changes rarely, so the notes are session-stable text.
  covel.provideExtension("prompt.segment@1", "character-notes", {
    async handler(_input, ctx) {
      return roleplayNoteSegments(
        await ctx.pluginData.list("blueprints"),
        ctx.world.characters,
        ctx.locale,
        ctx.world.dimensions,
      );
    },
  });
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
            character.id === `npc-${record.characterId}`,
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
