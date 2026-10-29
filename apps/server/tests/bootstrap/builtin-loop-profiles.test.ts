/**
 * The bundled narrators use the `story` loop profile through derivation, with
 * no manifest edit: every bundled story runtime resolves to the story preset
 * and declares no loop profile key, and every other bundled agent resolves to
 * the system preset.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { LOOP_PRESETS } from "@covel/shared";
import {
  discoverPluginsMulti,
  loadPluginDefinition,
} from "@covel/plugin-loader";
import { resolveLoopProfile } from "@covel/runtime";

it("derives the story preset for bundled stories and system for every other agent", async () => {
  const root = await fs.realpath(
    path.resolve(import.meta.dirname, "../../../../plugins"),
  );
  const discoveries = await discoverPluginsMulti([root]);
  expect(discoveries.length).toBeGreaterThan(0);
  let stories = 0;
  let agents = 0;
  for (const discovery of discoveries) {
    const definition = await loadPluginDefinition(discovery);
    for (const { manifest } of definition.manifests) {
      if (manifest.runtimeType === "function") continue;
      agents++;
      const story = manifest.outputKind === "story";
      if (story) {
        stories++;
        expect(manifest.loopProfile, manifest.name).toBeUndefined();
      }
      expect(resolveLoopProfile(manifest), manifest.name).toEqual(
        story
          ? { preset: "story", ...LOOP_PRESETS.story, answerPrompt: "story" }
          : {
              preset: "system",
              ...LOOP_PRESETS.system,
              answerPrompt: "answer",
            },
      );
    }
  }
  // The narrator and the chat-mode narrator.
  expect(stories).toBeGreaterThanOrEqual(2);
  expect(agents).toBeGreaterThan(stories);
});
