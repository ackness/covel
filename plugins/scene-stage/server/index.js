import { currentCharacterOf, primarySeat } from "@covel/plugin-handlers-utils";
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
      const current = await ctx.pluginData.get("active-cast", "current");
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
      let current = await ctx.pluginData.get("stage", "current");
      const registry = await ctx.pluginData.get("scenes", "scene-registry");
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
      let current = await ctx.pluginData.get("direction", "current");
      const stage = await ctx.pluginData.get("stage", "current");
      const registry = await ctx.pluginData.get("scenes", "scene-registry");
      if (current && stage?.sceneId) {
        // Resolve the scene preview before actor cues, matching the event
        // followers' DAG even when the model emitted actor cues first.
        let nextStage = stage;
        for (const event of events) {
          if (event.topic === "scene.set" && stage.turnId !== event.turnId)
            nextStage = applySceneSetPreview(
              ctx,
              nextStage,
              registry,
              event.data,
              event.turnId,
            );
        }
        if (nextStage.sceneId !== stage.sceneId)
          current = { ...current, actors: [] };
      }
      const previews = events.filter(
        (event) =>
          event.topic === "stage.direction" && current?.turnId !== event.turnId,
      );
      if (!current && !previews.length) return previous;
      let speakers = resolveStageSpeakers(current, []);
      const seats = ctx.world.seats ?? [];
      const viewpoint = currentCharacterOf(
        primarySeat(seats),
        ctx.world.characters,
        seats,
      );
      const characters = Object.fromEntries(
        ctx.world.characters
          .filter((character) => character.id !== viewpoint?.id)
          .map((character) => [
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
      if (
        !current &&
        !speakers.length &&
        !previews.some(
          (event) =>
            Array.isArray(event.data.cues) &&
            event.data.cues.some((cue) => cue?.type === "stage.clear"),
        )
      )
        return previous;
      return { actors: actors(speakers), retainWhenEmpty: false };
    },
  });
}
