import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildContext } from "@covel/context";
import {
  discoverPlugins,
  loadPluginManifest,
  loadPluginEntryDefinition,
  loadPluginDefinition,
  pluginDeclarations,
  resolvePluginRuntimeManifest,
} from "@covel/plugin-loader";
import { resolveUserSettings } from "../src/turn-executor/turn-executor-helpers.js";

const root = path.resolve(import.meta.dirname, "../../../plugins");

describe.each(["narrator", "chat-mode-narrator"])("%s perspective", (id) => {
  it.each(["zh-CN", "en-US"])(
    "renders the selected setting in %s",
    async (locale) => {
      const discovery = (await discoverPlugins(root)).find(
        (entry) => entry.id === id,
      )!;
      const loaded = (await loadPluginManifest(discovery, locale)).find(
        ({ manifest }) => manifest.outputKind === "story",
      )!;
      const definition = await loadPluginDefinition(discovery, locale);
      const manifest = resolvePluginRuntimeManifest(
        definition,
        loaded!.manifest,
      );
      const { staticPromptSegments } = await loadPluginEntryDefinition(
        discovery,
        pluginDeclarations(definition),
        definition.manifests,
      );
      for (const [supplied, expected] of [
        ["character-first", "character-first"],
        ["character-second", "character-second"],
        ["character-third", "character-third"],
        ["omniscient", "omniscient"],
        ["dm", "dm"],
        [undefined, "character-second"],
        ["invalid", "character-second"],
      ]) {
        const userSettings = resolveUserSettings(
          manifest,
          supplied === undefined
            ? undefined
            : { [id]: { perspective: supplied } },
        );
        const context = await buildContext({
          manifest,
          promptTemplate: loaded!.promptTemplate,
          turnInput: {
            sessionId: "session",
            turnId: "turn",
            origin: "player",
            playerMessage: "I open the door",
            locale,
          },
          completedResults: new Map(),
          messageHistory: [
            { role: "assistant", content: "You reach the door." },
          ],
          userSettings,
          promptSegments: staticPromptSegments.map((s) => ({
            ...s,
            audience: "self",
            volatility: "turn",
            providerPluginId: id,
          })),
        });
        expect(context.systemPrompt).toContain(
          locale === "zh-CN"
            ? `视角设置：${expected}`
            : `Perspective setting: ${expected}`,
        );
        expect(context.systemPrompt).not.toContain(
          "{{ userSettings.perspective }}",
        );
        const finalInstruction = context.messages.at(-1);
        expect(finalInstruction?.role).toBe("system");
        expect(finalInstruction?.content).toContain(
          locale === "zh-CN"
            ? "本回合旁白人称固定为 上文指定的人称"
            : "This turn's narration uses the perspective configured above",
        );
        expect(context.messages).toContainEqual({
          role: "assistant",
          content: "You reach the door.",
        });
        expect(
          manifest.userSettings
            ?.find((setting) => setting.key === "perspective")
            ?.options?.map((option) => option.value),
        ).toEqual([
          "character-first",
          "character-second",
          "character-third",
          "omniscient",
          "dm",
        ]);
      }
    },
  );
});
