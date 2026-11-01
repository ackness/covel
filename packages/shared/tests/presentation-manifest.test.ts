import { describe, expect, it } from "vitest";
import { runtimeAuthoringManifestSchema } from "../src/schemas/runtime-manifest.js";
import { runtimeManifestInputSchema } from "../src/schemas/plugin-schemas.js";
import { normalizeRuntimeManifest } from "../src/scheduling/normalize.js";
import type { RuntimeManifest } from "../src/types/plugin.js";
import {
  presentationCompletionSchema,
  presentationSnapshotSchema,
} from "../src/schemas/presentation.js";

const authored = {
  schedule: { stage: "post-turn" },
  function: {},
  presentation: {},
  effects: {
    reads: ["plugin-data:self:display"],
    writes: ["plugin-data:self:display"],
  },
  io: {
    inputs: {
      story: { from: { contract: "narrative-engine@2" }, required: false },
    },
  },
};
const compiled = {
  name: "display/cues",
  description: "Display",
  runtimeType: "function",
  handler: "./handler.js",
  stage: "post-turn",
  outputKind: "system",
  presentation: {},
  effects: authored.effects,
};
describe("presentation declarations", () => {
  it("validates content-free terminal diagnostics and bounded current snapshots", () => {
    const terminal = {
      pluginId: "display",
      runtimeId: "display/render",
      sourceTurnId: "source",
      sourceExecutionId: "execution",
      status: "no-op",
      reason: "no-output",
      budget: {
        calls: { limit: 1, used: 1 },
        generations: { limit: 0, used: 0 },
      },
    };
    expect(presentationCompletionSchema.safeParse(terminal).success).toBe(true);
    expect(
      presentationCompletionSchema.safeParse({ ...terminal, reason: undefined })
        .success,
    ).toBe(false);
    expect(
      presentationCompletionSchema.safeParse({
        ...terminal,
        reason: "private story detail",
      }).success,
    ).toBe(false);
    expect(
      presentationCompletionSchema.safeParse({ ...terminal, prompt: "private" })
        .success,
    ).toBe(false);
    const source = {
      version: 1,
      committed: true,
      story: { segments: [{ kind: "narration", text: "Public scene" }] },
      pluginId: "display",
      runtimeId: "display/render",
      sourceTurnId: "source",
      sourceExecutionId: "execution",
      limits: { calls: 1, generations: 1 },
      characters: [],
      data: {},
      baselines: {},
    };
    expect(presentationSnapshotSchema.safeParse(source).success).toBe(true);
    for (const change of [
      { version: 0 },
      { rawDigest: {} },
      {
        data: {
          art: Array.from({ length: 51 }, (_, key) => ({
            key: String(key),
            value: {},
          })),
        },
      },
      {
        characters: Array.from({ length: 101 }, (_, key) => ({
          id: String(key),
          name: "Actor",
        })),
      },
      { data: { art: [{ key: "large", value: "x".repeat(256 * 1024) }] } },
    ])
      expect(
        presentationSnapshotSchema.safeParse({ ...source, ...change }).success,
      ).toBe(false);
  });
  it("derives zero counters for a deterministic function", () => {
    expect(runtimeAuthoringManifestSchema.safeParse(authored).success).toBe(
      true,
    );
    expect(runtimeManifestInputSchema.safeParse(compiled).success).toBe(true);
    expect(
      normalizeRuntimeManifest({
        ...compiled,
        pluginId: "display",
      } as RuntimeManifest).presentation?.budget,
    ).toEqual({ calls: 0, generations: 0 });
  });
  it("accepts explicitly bounded detached work", () => {
    expect(
      runtimeAuthoringManifestSchema.safeParse({
        ...authored,
        schedule: { stage: "post-turn", detached: true },
        presentation: { budget: { calls: 2, generations: 1 } },
      }).success,
    ).toBe(true);
  });
  it.each([-1, 0.5, 17])("rejects an invalid call limit %s", (calls) => {
    expect(
      runtimeAuthoringManifestSchema.safeParse({
        ...authored,
        presentation: { budget: { calls } },
      }).success,
    ).toBe(false);
  });
  it.each([
    { presentation: { budget: { generations: 5 } } },
    { presentation: { unknown: true } },
    { presentation: { budget: { unknown: 1 } } },
    { function: undefined },
    { guard: "./guard.js" },
    { schedule: { stage: "pre-turn" } },
    { schedule: { stage: "audit" } },
    { schedule: { trigger: { type: "manual" } } },
    { schedule: { trigger: { type: "event", topic: "scene" } } },
    { schedule: { stage: "post-turn", subagentOnly: true } },
    { schedule: { stage: "post-turn", background: true } },
    { schedule: { stage: "post-turn", detached: { settle: true } } },
    { presentation: { budget: { calls: 1 } } },
    { io: { visibility: "story" } },
    { io: { concealed: true } },
    { io: { output: { recordAs: "history", schema: "./output.json" } } },
    { function: { tools: { builtin: ["suspend"] } } },
    { effects: { writes: ["plugin-data:self:*"] } },
    { effects: { writes: ["plugin-data:self:_hidden.assets"] } },
    { effects: { reads: ["history:*"] } },
  ])("rejects unsafe authored declarations: %j", (change) => {
    expect(
      runtimeAuthoringManifestSchema.safeParse({ ...authored, ...change })
        .success,
    ).toBe(false);
  });
  it.each([
    { from: { runtime: "story" }, required: false },
    { from: { contract: "narrative-engine@2" }, required: true },
    { from: { kernel: "turn-digest@1" } },
    {
      from: { contract: "narrative-engine@2" },
      required: false,
      select: "/private",
    },
    {
      from: { contract: "narrative-engine@2" },
      required: false,
      scope: "committed",
      recordAs: "story",
    },
  ])("refuses nonpublic input bindings %j", (binding) => {
    expect(
      runtimeAuthoringManifestSchema.safeParse({
        ...authored,
        io: { inputs: { story: binding } },
      }).success,
    ).toBe(false);
  });
  it("rechecks hand-built compiled read declarations", () => {
    expect(
      runtimeManifestInputSchema.safeParse({
        ...compiled,
        effects: { reads: ["plugin-data:self:secret"], writes: [] },
      }).success,
    ).toBe(false);
    expect(
      runtimeManifestInputSchema.safeParse({
        ...compiled,
        presentation: { publicAssetNamespaces: ["assets"] },
        effects: { reads: ["plugin-data:self:assets"], writes: [] },
      }).success,
    ).toBe(true);
  });
});
