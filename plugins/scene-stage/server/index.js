import {
  applySceneSetPreview,
  applyStageDirectionPreview,
  resolveStageSpeakers,
} from "../lib/stage-view.js";

const ref = (value) =>
  value &&
  typeof value === "object" &&
  typeof value.id === "string" &&
  typeof value.mime === "string" &&
  typeof value.size === "number";
const own = async (ctx, namespace, key) =>
  (await ctx.pluginData.get(namespace, key))?.value;
const actors = (speakers) =>
  speakers.map((speaker, index) => ({
    characterId: speaker.id,
    displayName: speaker.name,
    active: index === 0,
    ...(speaker.visual ? { visual: speaker.visual } : {}),
    ...(speaker.position ? { position: speaker.position } : {}),
    ...(speaker.transition ? { transition: speaker.transition } : {}),
    ...(speaker.exiting ? { exiting: true } : {}),
  }));

export default function (covel) {
  covel.provideExtension("ui.slot@1", "cast", {
    async handler(_input, ctx) {
      const current = await own(ctx, "active-cast", "current");
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
  covel.provideExtension("ui.slot@1", "backdrop", {
    async handler({ events }, ctx) {
      let current = await own(ctx, "stage", "current");
      const registry = await own(ctx, "scenes", "scene-registry");
      for (const event of events) {
        if (event.topic === "scene.set" && current?.turnId !== event.turnId)
          current = applySceneSetPreview(
            ctx,
            current,
            registry,
            event.data,
            event.turnId,
          );
      }
      const preload = (registry?.scenes ?? [])
        .flatMap((scene) => [scene.day, scene.night])
        .filter(ref);
      return {
        ...(current?.sceneId ? { sceneId: current.sceneId } : {}),
        ...(current?.name ? { name: current.name } : {}),
        ...(current?.variant ? { variant: current.variant } : {}),
        ...(current?.sourceLabel ? { label: current.sourceLabel } : {}),
        ...(ref(current?.resolved) ? { ref: current.resolved } : {}),
        preload,
      };
    },
  });
  covel.provideExtension("ui.slot@1", "direction", {
    async handler({ previous, events }, ctx) {
      const current = await own(ctx, "direction", "current");
      const previews = events.filter(
        (event) =>
          event.topic === "stage.direction" && current?.turnId !== event.turnId,
      );
      if (!current && !previews.length) return previous;
      let speakers = resolveStageSpeakers(
        current,
        (previous?.actors ?? []).map((actor) => ({
          id: actor.characterId,
          name: actor.displayName,
          ...actor,
        })),
      );
      const characters = Object.fromEntries(
        ctx.world.characters.map((character) => [
          character.id,
          {
            characterId: character.id,
            displayName: character.name,
          },
        ]),
      );
      for (const event of previews)
        speakers = applyStageDirectionPreview(
          speakers,
          characters,
          event.data.cues,
        );
      return { actors: actors(speakers), retainWhenEmpty: false };
    },
  });
  covel.provideExtension("ui.slot@1", "dialogue", {
    async handler({ events }, ctx) {
      const preview = events
        .filter((event) => event.topic === "stage.direction")
        .at(-1);
      if (preview) {
        const mapping = preview.data.dialogue?.paragraphSpeakers;
        return {
          turnId: preview.turnId,
          paragraphSpeakers: Array.isArray(mapping)
            ? mapping.map((id) =>
                id === null
                  ? null
                  : (ctx.world.characters.find(
                      (character) => character.id === id,
                    )?.name ?? null),
              )
            : [],
        };
      }
      const rows = await ctx.pluginData.list("dialogue");
      const latest = [...rows]
        .sort((a, b) =>
          String(a.updatedAt ?? "").localeCompare(String(b.updatedAt ?? "")),
        )
        .at(-1)?.value;
      return {
        ...(latest?.turnId ? { turnId: latest.turnId } : {}),
        paragraphSpeakers: (latest?.paragraphSpeakers ?? []).map(
          (speaker) => speaker?.displayName ?? null,
        ),
      };
    },
  });
}
