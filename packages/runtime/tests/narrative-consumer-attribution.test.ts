import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  discoverPlugins,
  loadPluginDefinition,
  loadRuntime,
} from "@covel/plugin-loader";
import { normalizeStoryOutput } from "../src/agent-loop/story-output.js";
import { resolveInputBindings } from "../src/schedule/input-bindings.js";
import { cases } from "./helpers/narrative-attribution-cases.js";
import { runAttributionTurn } from "./helpers/narrative-attribution.js";

const pluginsDir = path.resolve(import.meta.dirname, "../../../plugins");

// These tests prove transport and source separation, not a model's accuracy.
// Real loaders, contracts, stage execution, context/hooks, writer tools and
// commit run against an in-memory session. The model only submits empty batches.
describe.each(["en-US", "zh-CN"])("narrative consumers in %s", (locale) => {
  it.each(cases)(
    "preserves $name at every writer without changing story text",
    async (fixture) => {
      const network = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => {
          throw new Error("This synthetic fixture must not use the network");
        });
      try {
        const segments = locale === "zh-CN" ? fixture.zh : fixture.en;
        const result = await runAttributionTurn(
          pluginsDir,
          { segments },
          locale,
          "synthetic-story",
        );
        expect(result.calls.map((c) => c.tool).sort()).toEqual(
          ["submit-world-facts", "sync-characters", "update-dimensions"].sort(),
        );
        expect(result.results.map((r) => [r.name, r.status])).toEqual([
          ["synthetic-story", "success"],
          ["char-creator/character-tracker", "success"],
          ["world-ir", "success"],
          ["world-init/dimension-tracker", "success"],
        ]);
        const currentPlayerText =
          locale === "zh-CN"
            ? "我先不答应。我问：你说的‘我带你去’是什么意思？"
            : "I have not agreed. I ask: what did you mean by ‘I will guide you’?";
        for (const call of result.calls) {
          const allText = call.messages.map((m) => m.content).join("\n");
          expect(allText).not.toContain('"resultId"');
          expect(allText).not.toContain('"timestamp"');
          if (call.tool === "submit-world-facts") {
            const data = JSON.parse(String(call.messages.at(-1)!.content));
            expect(data.narrative).toEqual({
              cardinality: "one",
              value: segments,
            });
            expect(data.playerInput).toEqual({
              character: locale === "zh-CN" ? "阿历克斯" : "alex",
              text: currentPlayerText,
            });
            expect(allText).not.toContain("char-player");
            expect(allText).not.toContain("char-mira");
            expect(data).not.toHaveProperty("turn");
            expect(data.narrative).not.toHaveProperty("source");
          } else {
            const json = allText.match(
              /<runtime-inputs>\n(.*?)\n<\/runtime-inputs>/s,
            )![1]!;
            const slots = JSON.parse(
              json
                .replaceAll("&lt;", "<")
                .replaceAll("&gt;", ">")
                .replaceAll("&amp;", "&"),
            );
            expect(
              slots[
                call.tool === "sync-characters"
                  ? "narrator-output"
                  : "narrative"
              ].value,
            ).toEqual(segments);
            // The standard assembler preserves the player input independently.
            expect(call.messages).toContainEqual({
              role: "user",
              content: currentPlayerText,
            });
            if (call.tool === "sync-characters") {
              expect(allText).toContain(
                locale === "zh-CN" ? "守书人" : "the Keeper",
              );
            }
          }
        }
        const prose = segments.map((s) => s.text).join("\n\n");
        expect(result.results[0]?.output?.narrativeOutput).toBe(prose);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0]?.content).toBe(prose);
        const metadata = result.messages[0]?.metadata as {
          segments: { text: string; speaker?: string }[];
        };
        expect(metadata.segments.map((s) => s.text)).toEqual(
          segments.map((s) => s.text),
        );
        if (fixture.name === "alias") {
          // Commit still resolves an exact alias for UI metadata only.
          expect(metadata.segments[0]?.speaker).toBe(
            locale === "zh-CN" ? "米拉" : "Mira",
          );
        }
        expect(network).not.toHaveBeenCalled();
      } finally {
        network.mockRestore();
      }
    },
  );
});

it.each(["narrator", "chat-mode-narrator"])(
  "accepts normalized prose from %s's current contract",
  async (provider) => {
    const result = await runAttributionTurn(
      pluginsDir,
      normalizeStoryOutput({
        narrativeOutput: "A bell rings.\n\nSomeone leaves.",
      })!,
      "en-US",
      provider,
    );
    expect(result.results.every((r) => r.status === "success")).toBe(true);
    const world = JSON.parse(
      String(
        result.calls
          .find((c) => c.tool === "submit-world-facts")!
          .messages.at(-1)!.content,
      ),
    );
    expect(world.narrative.value).toEqual([
      { kind: "narration", text: "A bell rings." },
      { kind: "narration", text: "Someone leaves." },
    ]);
    expect(result.messages[0]?.content).toBe(
      "A bell rings.\n\nSomeone leaves.",
    );
  },
);

it("validates the public @2 output before selecting segments, without a duplicate accepts schema", async () => {
  const discoveries = await discoverPlugins(pluginsDir);
  const provider = discoveries.find((d) => d.id === "narrator")!;
  const definition = await loadPluginDefinition(provider);
  const contracts = definition.packageManifest.contractSchemas;
  const producer = await loadRuntime(provider, "narrator");
  for (const [pluginId, runtimeId, slot] of [
    ["world-ir", "world-ir", "narrative"],
    ["char-creator", "char-creator/character-tracker", "narrator-output"],
    ["world-init", "world-init/dimension-tracker", "narrative"],
  ] as const) {
    const loaded = await loadRuntime(
      discoveries.find((d) => d.id === pluginId)!,
      runtimeId,
      "en-US",
      undefined,
      contracts,
    );
    expect(loaded.manifest.inputs?.[slot]?.select).toBe("/segments");
    expect(loaded.bindingContractSchemas?.[slot]).toMatchObject({
      required: ["segments"],
    });
    expect(loaded.bindingAcceptsSchemas?.[slot]).toBeUndefined();
    const resolution = await resolveInputBindings({
      manifest: loaded.manifest,
      activation: { source: "stage", detached: false, payload: null },
      activeRuntimes: [producer.manifest, loaded.manifest],
      completedResults: new Map([
        [
          producer.manifest.name,
          {
            runtimeId: producer.manifest.name,
            pluginId: producer.manifest.pluginId,
            status: "success",
            runId: "source-run",
            turnId: "source-turn",
            output: {
              segments: [{ kind: "dialogue", speaker: "Mira", text: 7 }],
              narrativeOutput: "Looks valid as prose.",
            },
            toolCalls: [],
            durationMs: 0,
            timestamp: "2026-01-01T00:00:00Z",
          },
        ],
      ]),
      acceptsSchemas: loaded.bindingAcceptsSchemas ?? {},
      contractSchemas: loaded.bindingContractSchemas,
      loadProducerSchema: async () => producer.outputSchema,
    });
    expect(
      resolution.diagnostics.some((d) => d.code === "contract-output-invalid"),
    ).toBe(true);
    if (resolution.ok) expect(resolution.slots).not.toHaveProperty(slot);
    else expect(resolution.skipReason).toBe("contract-output-invalid");
  }
});

it.each([
  ["zh-CN", "en", "not automatically to the player", "不自动属于玩家"],
  ["en-US", "zh", "不自动属于玩家", "not automatically to the player"],
])(
  "%s content retains attribution under the %s instruction override",
  async (locale, override, expected, unexpected) => {
    vi.stubEnv("COVEL_INSTRUCTION_LOCALE", override);
    try {
      const segments = locale === "zh-CN" ? cases[0]!.zh : cases[0]!.en;
      const first = segments[0];
      if (!first || !("speaker" in first))
        throw new Error("Expected a named speaker fixture");
      const result = await runAttributionTurn(pluginsDir, { segments }, locale);
      expect(result.calls).toHaveLength(3);
      for (const call of result.calls) {
        const instructions = call.messages
          .filter((m) => m.role === "system")
          .map((m) => m.content)
          .join("\n");
        expect(instructions).toContain(expected);
        expect(instructions).not.toContain(unexpected);
        expect(call.messages.map((m) => m.content).join("\n")).toContain(
          first.speaker,
        );
      }
    } finally {
      vi.unstubAllEnvs();
    }
  },
);
