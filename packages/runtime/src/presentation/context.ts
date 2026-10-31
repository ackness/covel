import { listPluginDataProducers } from "../function-runtime/upstream-plugin-data.js";
import {
  applyDataOps,
  dataOpsSchema,
  pluginDataSizeError,
  pluginMessagesFor,
  presentationReasonSchema,
  type JsonValue,
  type MediaRef,
  type PresentationSnapshot,
} from "@covel/shared";
import type {
  FunctionHandlerContext,
  PluginDataWriter,
} from "@covel/shared/plugin-runtime";
import type { MediaStore } from "@covel/store";
import { overlayPluginDataValue } from "@covel/tools";
import type {
  PluginRuntimeContext,
  PluginRuntimeContextOptions,
} from "../function-runtime/plugin-runtime-context.js";
import {
  bufferPluginData,
  bufferPluginDataDelete,
  bufferPluginDataUpdate,
  mergePluginDataRows,
} from "../function-runtime/execution-write-buffer.js";
import { createPluginRandom } from "../function-runtime/plugin-random.js";
import { getTurnExecutionSignal } from "../turn-executor/turn-control.js";
import { resolveUserSettings } from "../turn-executor/turn-executor-helpers.js";
import { deepFreeze } from "../hooks/hook-settings.js";
import {
  withDefaultGatewaySignal,
  withDefaultUtilsSignal,
  withStalledCallRetry,
} from "../function-runtime/runtime-abort-boundaries.js";
import { withRuntimeTextDefaults } from "../function-runtime/plugin-runtime-gateway.js";
import {
  promptCacheKeyFor,
  withPromptCacheKey,
} from "../llm/prompt-cache-key.js";
import {
  createRuntimeMediaContext,
  createRuntimeMediaWriter,
} from "../function-runtime/runtime-media-context.js";
import { createRuntimeImagesContext } from "../function-runtime/runtime-images-context.js";
import { createRuntimeMusicContext } from "../function-runtime/runtime-music-context.js";
import { createRuntimeSpeechContext } from "../function-runtime/runtime-speech-context.js";
import { enforceHttpPermissions } from "../function-runtime/http-permissions.js";
import { isTrustedPluginSource } from "../turn-executor/turn-runtime-helpers.js";
import { makeRevocableCapability } from "../function-runtime/plugin-handler-helpers.js";
import { createPresentationBudget } from "./budget.js";
import { presentationLimits, presentationNamespaces } from "./policy.js";
import { presentationGateway, publicPresentationGateway } from "./gateway.js";
import type { PresentationState } from "./state.js";
import { PresentationUnavailable } from "./projection.js";

export function presentationMediaIds(
  value: unknown,
  into = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) presentationMediaIds(item, into);
  } else if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    if (
      typeof item.id === "string" &&
      typeof item.mime === "string" &&
      typeof item.size === "number"
    )
      into.add(item.id);
    for (const child of Object.values(item)) presentationMediaIds(child, into);
  }
  return into;
}

/** This path never constructs a general store, world, service or tool facade. */
export async function createPresentationContext(
  options: PluginRuntimeContextOptions,
  source: PresentationSnapshot,
): Promise<PluginRuntimeContext> {
  const { manifest, input, deps, writeBuffer } = options;
  const snapshot = deepFreeze(structuredClone(source));
  const identity = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
  };
  const abort = new AbortController();
  const parent = getTurnExecutionSignal(deps.turnControl);
  const relay = () => abort.abort(parent?.reason);
  if (parent?.aborted) relay();
  else parent?.addEventListener("abort", relay, { once: true });
  let revoked = false;
  const assertLive = () => {
    if (revoked) throw new Error("Presentation capability revoked");
    abort.signal.throwIfAborted();
  };
  const refuse = (): never => {
    assertLive();
    throw new Error("Capability unavailable to presentation runtimes");
  };
  const state: PresentationState = {
    ...(input.detachedStage ? { jobId: input.detachedStage.jobId } : {}),
    snapshot,
    budget: createPresentationBudget({
      store: deps.store,
      sessionId: input.sessionId,
      snapshot,
      currentLimits: presentationLimits(manifest),
      assertLive,
    }),
    ...(!snapshot.story ? { reason: "no-story" as const } : {}),
    mediaIds: presentationMediaIds(snapshot.data),
  };
  await state.budget.refresh().catch((error: unknown) => {
    if (!(error instanceof PresentationUnavailable)) throw error;
    state.reason ??= "unavailable";
  });
  const { reads, writes } = presentationNamespaces(manifest);
  const check = (namespace: string, allowed: ReadonlySet<string>) => {
    assertLive();
    if (
      typeof namespace !== "string" ||
      namespace.startsWith("_") ||
      !allowed.has(namespace)
    )
      refuse();
  };
  const current = (namespace: string, key: string) => {
    for (const id of listPluginDataProducers(
      options.pluginDataVisibility,
      namespace,
    ))
      options.pluginDataVisibility?.recorder.add(id);
    const row = snapshot.data[namespace]?.find((row) => row.key === key);
    return overlayPluginDataValue(
      writeBuffer,
      manifest.pluginId,
      namespace,
      key,
      row ? { exists: true, value: row.value } : { exists: false },
    );
  };
  const pluginData: PluginDataWriter = {
    async get(namespace, key) {
      check(namespace, reads);
      const value = current(namespace, key);
      return value.exists ? structuredClone(value.value) : null;
    },
    async list(namespace) {
      check(namespace, reads);
      for (const id of listPluginDataProducers(
        options.pluginDataVisibility,
        namespace,
      ))
        options.pluginDataVisibility?.recorder.add(id);
      const stored = (snapshot.data[namespace] ?? []).map((row) => ({
        ...row,
        id: row.key,
        sessionId: input.sessionId,
        pluginId: manifest.pluginId,
        namespace,
        createdAt: "",
        updatedAt: "",
      }));
      return structuredClone(
        mergePluginDataRows(
          stored,
          writeBuffer,
          input.sessionId,
          manifest.pluginId,
          namespace,
        ).map(({ key, value }) => ({ key, value })),
      );
    },
    async set(namespace, key, value) {
      check(namespace, writes);
      const error = pluginDataSizeError(
        manifest.pluginId,
        namespace,
        key,
        value,
      );
      if (error) throw new Error(error);
      if (value === null)
        bufferPluginDataDelete(writeBuffer, identity, namespace, key);
      else bufferPluginData(writeBuffer, identity, namespace, key, value);
    },
    async delete(namespace, key) {
      check(namespace, writes);
      bufferPluginDataDelete(writeBuffer, identity, namespace, key);
    },
    async update(namespace, key, raw) {
      check(namespace, writes);
      const ops = dataOpsSchema.parse(raw);
      const before = current(namespace, key);
      const next = applyDataOps(
        before.exists
          ? { exists: true, value: before.value as JsonValue }
          : { exists: false },
        ops,
      );
      if (!next.ok) throw new Error("Presentation data operations rejected");
      bufferPluginDataUpdate(writeBuffer, identity, namespace, key, ops);
    },
  };
  const revocable = <T extends object>(value: T, name: string) =>
    makeRevocableCapability(value, () => revoked || abort.signal.aborted, name);
  const rawGateway = deps.gateway
    ? withPromptCacheKey(
        withDefaultGatewaySignal(
          withRuntimeTextDefaults(
            deps.gateway,
            snapshot.locale,
            manifest.model,
          ),
          abort.signal,
        ),
        promptCacheKeyFor(input.sessionId, manifest.name),
      )
    : undefined;
  const gateway = rawGateway
    ? withStalledCallRetry(
        presentationGateway(rawGateway, state, assertLive, deps.emitter),
        {
          deadline: options.startTime + options.timeoutMs,
          runtimeId: manifest.name,
        },
      )
    : undefined;
  const utils = deps.utils
    ? enforceHttpPermissions(withDefaultUtilsSignal(deps.utils, abort.signal), {
        isCommunity: !isTrustedPluginSource(deps, manifest),
        httpPermissions: manifest.permissions?.http ?? [],
        runtimeId: manifest.name,
      })
    : undefined;
  const mediaOptions = {
    sessionId: input.sessionId,
    pluginId: manifest.pluginId,
    signal: abort.signal,
  };
  const writer = deps.mediaStore
    ? createRuntimeMediaContext(deps.mediaStore, utils, mediaOptions)
    : undefined;
  const mediaAllowed = [
    ...(manifest.effects?.reads ?? []),
    ...(manifest.effects?.writes ?? []),
  ].some((effect) => effect === "media:*" || effect === "assets:*");
  const mediaWrites = (manifest.effects?.writes ?? []).some(
    (effect) => effect === "media:*" || effect === "assets:*",
  );
  const mediaCache: Pick<MediaStore, "listByMetadata"> | undefined =
    deps.mediaStore
      ? {
          async listByMetadata(sessionId, query) {
            assertLive();
            const rows = await deps.mediaStore!.listByMetadata(
              sessionId,
              query,
            );
            assertLive();
            return rows.filter((row) => state.mediaIds.has(row.id));
          },
        }
      : undefined;
  const keep = async <
    T extends { readonly refs: readonly MediaRef[]; readonly cached: boolean },
  >(
    work: Promise<T>,
  ): Promise<T> => {
    const result = await work;
    assertLive();
    for (const ref of result.refs) state.mediaIds.add(ref.id);
    if (result.cached)
      await deps.emitter?.emit("gateway.responded", {
        ...identity,
        cached: true,
      });
    return result;
  };
  const images =
    gateway?.generateImage && deps.mediaStore && mediaCache && mediaWrites
      ? createRuntimeImagesContext(
          {
            generateImage: gateway.generateImage,
            resolveSlot: gateway.resolveSlot,
          },
          mediaCache,
          createRuntimeMediaWriter(deps.mediaStore, utils, mediaOptions),
          mediaOptions,
        )
      : undefined;
  const music =
    gateway?.composeMusic && mediaCache && writer && mediaWrites
      ? createRuntimeMusicContext(
          {
            composeMusic: gateway.composeMusic,
            resolveSlot: gateway.resolveSlot,
          },
          mediaCache,
          writer,
          mediaOptions,
        )
      : undefined;
  const speech =
    gateway?.synthesizeSpeech && mediaCache && writer && mediaWrites
      ? createRuntimeSpeechContext(
          {
            synthesizeSpeech: gateway.synthesizeSpeech,
            transcribeAudio: refuse,
            resolveSlot: gateway.resolveSlot,
          },
          mediaCache,
          writer,
          mediaOptions,
        )
      : undefined;
  const messages = pluginMessagesFor(options.loaded.messages, snapshot.locale);
  const context: FunctionHandlerContext = {
    ...identity,
    playerMessage: "",
    playerActions: [],
    session: { lastPlayerInput: null },
    locale: snapshot.locale,
    ...(messages ? { messages } : {}),
    logicalTurn: options.logicalTurn,
    execution: {
      origin: options.executionContext.origin,
      sourceTurnId: snapshot.sourceTurnId,
    },
    activation: {
      source: "stage",
      detached: Boolean(input.detachedStage),
      payload: null,
    },
    userSettings: deepFreeze(
      structuredClone(resolveUserSettings(manifest, input.userSettings) ?? {}),
    ),
    inputs: deepFreeze(
      Object.fromEntries(
        Object.keys(manifest.inputs ?? {}).flatMap((name) =>
          snapshot.story
            ? [
                [
                  name,
                  {
                    cardinality: "one" as const,
                    value: snapshot.story as unknown as JsonValue,
                    source: {
                      pluginId: "__kernel",
                      runtimeId: "presentation",
                      resultId: snapshot.sourceTurnId,
                    },
                  },
                ],
              ]
            : [],
        ),
      ),
    ),
    presentation: revocable(
      {
        characters: snapshot.characters,
        ...(snapshot.viewpointCharacterId
          ? { viewpointCharacterId: snapshot.viewpointCharacterId }
          : {}),
        note(reason) {
          assertLive();
          state.reason = presentationReasonSchema.parse(reason);
        },
      },
      "presentation",
    ),
    pluginData: revocable(pluginData, "pluginData"),
    store: {
      async getPluginData(namespace, key) {
        const value = await pluginData.get(namespace, key);
        return value === null ? null : { key, value };
      },
      listPluginData: (namespace) => pluginData.list(namespace),
      getSession: refuse,
      listPlayerInputs: refuse,
      listTurnMessages: refuse,
      readTurnMessages: refuse,
    },
    historyFor: refuse,
    recursiveCall: refuse,
    recursionDepth: 0,
    tools: { call: refuse },
    agents: { run: refuse },
    ...(gateway
      ? {
          gateway: revocable(
            publicPresentationGateway(
              mediaWrites
                ? gateway
                : {
                    resolveSlot: gateway.resolveSlot,
                    generateText: gateway.generateText,
                    generateObject: gateway.generateObject,
                  },
            ),
            "gateway",
          ),
        }
      : {}),
    ...(writer && mediaAllowed
      ? {
          media: revocable(
            {
              put: refuse,
              ingestUrl: refuse,
              async get(ref: MediaRef) {
                assertLive();
                if (!state.mediaIds.has(ref.id)) refuse();
                return writer.get(ref);
              },
            },
            "media",
          ),
        }
      : {}),
    ...(images
      ? {
          images: revocable(
            {
              isAvailable: images.isAvailable,
              generate: (request: Parameters<typeof images.generate>[0]) => {
                assertLive();
                const n = request.n ?? 1;
                if (!Number.isSafeInteger(n) || n < 1 || n > 4)
                  throw new RangeError(
                    "Presentation image count must be an integer from 1 to 4",
                  );
                return keep(
                  images.generate({ ...request, signal: abort.signal }),
                );
              },
            },
            "images",
          ),
        }
      : {}),
    ...(music
      ? {
          music: revocable(
            {
              isAvailable: music.isAvailable,
              generate: (request: Parameters<typeof music.generate>[0]) =>
                keep(music.generate({ ...request, signal: abort.signal })),
            },
            "music",
          ),
        }
      : {}),
    ...(speech
      ? {
          speech: revocable(
            {
              transcribe: refuse,
              generate: (request: Parameters<typeof speech.generate>[0]) =>
                keep(speech.generate({ ...request, signal: abort.signal })),
            },
            "speech",
          ),
        }
      : {}),
    random: revocable(
      { ...createPluginRandom({ ...identity, stream: manifest.name }) },
      "random",
    ),
    signal: abort.signal,
  };
  return {
    context,
    abort,
    presentation: state,
    tools: {
      tools: { call: refuse },
      records: [],
      events: [],
      drain: async () => {},
    },
    nestedResults: [],
    readDependencies: () =>
      options.pluginDataVisibility
        ? [...options.pluginDataVisibility.recorder]
        : [],
    revoke: () => {
      revoked = true;
    },
    drain: async () => {},
    dispose: () => parent?.removeEventListener("abort", relay),
  };
}
