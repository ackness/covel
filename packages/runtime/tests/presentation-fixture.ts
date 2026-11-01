import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store";
import type { FunctionHandler } from "@covel/shared/plugin-runtime";
import type {
  PresentationSnapshot,
  PresentationStory,
  RuntimeManifest,
  TurnInput,
} from "@covel/shared";
import { executeTurn } from "../src/execution.js";
import { commitExecution } from "../src/commit/commit-execution.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import { createTurnEmitter } from "../src/trace/turn-emitter.js";
import { emptyPresentationDigest } from "../src/presentation/projection.js";

export const timestamp = "2026-10-31T00:00:00.000Z";
export const story = {
  segments: [
    { kind: "dialogue", speaker: "Mira", text: "The library is open." },
  ],
  cues: { scene: "Library", present: ["Mira"] },
} satisfies PresentationStory;
export const narrator: RuntimeManifest = {
  name: "story",
  pluginId: "story",
  description: "Public story",
  runtimeType: "function",
  handler: "./handler.js",
  stage: "narrative",
  outputKind: "story",
  outputContract: "narrative-engine@2",
};
export function presenter(
  extra: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name: "display/cues",
    pluginId: "display",
    description: "Select display",
    runtimeType: "function",
    handler: "./handler.js",
    stage: "post-turn",
    outputKind: "system",
    trigger: { type: "auto" },
    presentation: { publicAssetNamespaces: ["assets"] },
    inputs: {
      story: { from: { capability: "narrative-engine@2" }, required: false },
    },
    effects: {
      reads: ["plugin-data:self:assets", "plugin-data:self:display"],
      writes: ["plugin-data:self:display"],
    },
    ...extra,
  };
}
export const input: TurnInput = {
  sessionId: "session",
  turnId: "source",
  origin: "player",
  playerMessage: "private-player-input",
  locale: "en-US",
};
export function detachedInput(
  manifest: RuntimeManifest,
  snapshot: PresentationSnapshot,
): TurnInput {
  return {
    sessionId: "session",
    turnId: crypto.randomUUID(),
    origin: "background",
    playerMessage: "",
    manualTrigger: { runtimeId: manifest.name },
    detachedStage: {
      jobId: crypto.randomUUID(),
      runtimeId: manifest.name,
      sourceTurnId: snapshot.sourceTurnId,
      sourceExecutionId: snapshot.sourceExecutionId,
      sourceExecutionStartedAt: timestamp,
      sourceLogicalTurn: 1,
      upstreamResults: [],
      turnDigest: emptyPresentationDigest(snapshot.sourceTurnId),
      presentation: snapshot,
    },
  };
}
export async function setup(store: DataStore = createMemoryStore()) {
  await store.createSession({
    id: "session",
    worldId: "world",
    locale: "en-US",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    activePlugins: ["story", "display"],
    seats: [],
    metadata: {
      sessionIncarnationNonce: "private-incarnation",
      secret: "private-session",
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await store.upsertCharacter({
    id: "mira",
    name: "Mira",
    aliases: ["M"],
    sessionId: "session",
    type: "npc",
    fields: { secret: "private-character" },
    description: "private-profile",
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const seed = async (namespace: string, key: string, value: unknown) =>
    store.setPluginData({
      id: crypto.randomUUID(),
      sessionId: "session",
      pluginId: "display",
      namespace,
      key,
      value,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  await seed("assets", "library", { label: "Public library art" });
  await seed("_hidden.assets", "hidden", "private-hidden");
  await seed("forbidden", "private", "private-own");
  const emitter = createTurnEmitter({
    store,
    sessionId: "session",
    turnId: "source",
  });
  const deps = (
    handlers: Record<string, FunctionHandler>,
    extra: Partial<TurnExecutorDeps> = {},
  ): TurnExecutorDeps & { store: DataStore } => ({
    emitter,
    llm: {
      generate: async () => {
        throw new Error("Unexpected model call");
      },
    },
    loadRuntime: async (manifest) => ({
      manifest,
      promptTemplate: "",
      handler:
        handlers[manifest.name] ??
        (async () => ({ outcome: "success", value: story })),
    }),
    ...extra,
    store,
  });
  const run = (
    handler: FunctionHandler,
    manifest = presenter(),
    extra: Partial<TurnExecutorDeps> = {},
    turn = input,
  ) =>
    executeTurn(
      turn,
      [narrator, manifest],
      deps({ [manifest.name]: handler }, extra),
    );
  const commit = (
    execution: Parameters<typeof commitExecution>[0]["execution"],
    extra: Partial<Parameters<typeof commitExecution>[0]> = {},
  ) =>
    commitExecution({
      store,
      execution,
      emitter,
      completion: {
        kind: "turn",
        turnId: execution.result.turnId,
        durationMs: 0,
      },
      ...extra,
    });
  return { store, seed, deps, run, commit, emitter };
}
