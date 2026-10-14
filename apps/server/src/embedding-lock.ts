import { createHash } from "node:crypto";
import { EmbeddingModelChangedError, type EmbedFn } from "@covel/memory";
import type { GatewayOptions, ResolvedSlotConfig } from "@covel/ai-provider";
import type {
  DataStore,
  EmbeddingModelIdentity,
  VectorTarget,
} from "@covel/store";
import { trimTrailingSlashes } from "@covel/shared";
import { supportsVector } from "@covel/store/vector";
import type { AiStack } from "./ai-setup.js";
import { getRequestLlmOptions } from "./request-llm-context.js";

function embeddingOptions(apiKeys?: Record<string, string>): GatewayOptions {
  return getRequestLlmOptions() ?? (apiKeys ? { envApiKeys: apiKeys } : {});
}

function embeddingRole(options: GatewayOptions): string | undefined {
  return options.slotOverrides?.slotBindings?.embed ? "embed" : undefined;
}

/** Pin the effective vector space, including endpoint and encoding, without storing credentials. */
export function embeddingModelIdentity(target: ResolvedSlotConfig): string {
  const endpoint =
    typeof target.baseUrl === "string"
      ? trimTrailingSlashes(target.baseUrl)
      : null;
  const routing = JSON.stringify([
    target.provider,
    target.model,
    endpoint,
    target.protocol,
    target.metadata?.embeddingFormat ?? "openai",
  ]);
  return `${target.provider}/${target.model}#${createHash("sha256").update(routing).digest("hex")}`;
}

function resolveEmbedding(
  ai: Pick<AiStack, "gateway">,
  options: GatewayOptions,
): ResolvedSlotConfig | null {
  return ai.gateway.resolveSlot(embeddingRole(options), {
    ...options,
    fallbackTag: "embedding",
  });
}

function embeddingConfiguration(target: ResolvedSlotConfig) {
  return {
    ...(target.baseUrl ? { baseUrl: trimTrailingSlashes(target.baseUrl) } : {}),
    protocol: target.protocol,
    embeddingFormat: target.metadata?.embeddingFormat,
  };
}

/** One vector request: the dimension of the target's vector space. Throws when it fails. */
async function probeDimension(
  ai: Pick<AiStack, "gateway">,
  options: GatewayOptions,
  target: ResolvedSlotConfig,
): Promise<number> {
  const result = await ai.gateway.embed(
    {
      presetId: embeddingRole(options),
      values: ["covel-embed-probe"],
      expectedModelId: `${target.provider}/${target.model}`,
      expectedConfiguration: embeddingConfiguration(target),
    },
    options,
  );
  const vector = result.embeddings[0];
  if (!Array.isArray(vector) || vector.length === 0)
    throw new Error("The embedding model returned an empty vector");
  return vector.length;
}

/** The embedding model the configuration selects, as a player names it. */
export interface ConfiguredEmbeddingModel {
  /** The identity a session's index is locked to (`provider/model#hash`). */
  readonly modelId: string;
  readonly provider: string;
  readonly modelName: string;
}

/** What the memory index routes need from the model configuration. */
export interface MemoryIndexControl {
  /** The model the current request's configuration selects; null when none is configured. */
  configured(): ConfiguredEmbeddingModel | null;
  /**
   * The vector target of that model, its dimension measured with one request.
   * Null when no embedding model is configured. Throws when the request fails,
   * so a caller can stop before it discards an index.
   */
  configuredTarget(): Promise<VectorTarget | null>;
}

/** Read the embedding configuration with the request's model settings and keys. */
export function createMemoryIndexControl(opts: {
  store: DataStore;
  ai: Pick<AiStack, "gateway">;
  apiKeys?: Record<string, string>;
}): MemoryIndexControl {
  const { store, ai, apiKeys } = opts;
  const resolveConfigured = (options: GatewayOptions) => {
    try {
      return resolveEmbedding(ai, options);
    } catch {
      return null;
    }
  };
  return {
    configured() {
      const target = resolveConfigured(embeddingOptions(apiKeys));
      return target
        ? {
            modelId: embeddingModelIdentity(target),
            provider: target.provider,
            modelName: target.model,
          }
        : null;
    },
    async configuredTarget() {
      if (!supportsVector(store)) return null;
      const options = embeddingOptions(apiKeys);
      const target = resolveConfigured(options);
      if (!target) return null;
      const dim = await probeDimension(ai, options, target);
      return store.ensureVectorModel({
        provider: target.provider,
        modelName: target.model,
        dim,
        modelId: embeddingModelIdentity(target),
      });
    },
  };
}

/** Share one lock per session while every probe uses its originating request configuration. */
export function createEmbeddingLockHelper(opts: {
  store: DataStore;
  ai: AiStack;
  apiKeys?: Record<string, string>;
}): (sessionId: string) => Promise<void> {
  const { store, ai, apiKeys } = opts;
  const inflight = new Map<string, Promise<VectorTarget | null>>();
  const dimCache = new Map<string, number>();

  async function lockOnce(
    sessionId: string,
    options: GatewayOptions,
  ): Promise<VectorTarget | null> {
    if (!supportsVector(store)) return null;
    const existing = await store.resolveSessionVectorTarget(sessionId);
    if (existing) return existing;

    let target: ResolvedSlotConfig | null;
    try {
      target = resolveEmbedding(ai, options);
    } catch {
      return null;
    }
    if (!target) return null;
    const modelId = embeddingModelIdentity(target);
    let dim = dimCache.get(modelId);
    if (dim === undefined) {
      try {
        dim = await probeDimension(ai, options, target);
        dimCache.set(modelId, dim);
      } catch (error) {
        console.warn(
          `[embedding-lock] embed probe failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    }
    const identity: EmbeddingModelIdentity = {
      provider: target.provider,
      modelName: target.model,
      dim,
      modelId,
    };
    const vectorTarget = await store.ensureVectorModel(identity);
    try {
      await store.lockSessionEmbeddingModel(sessionId, vectorTarget);
    } catch (error) {
      const reread = await store.resolveSessionVectorTarget(sessionId);
      if (reread) return reread;
      throw error;
    }
    return vectorTarget;
  }

  return async (sessionId) => {
    const pending = inflight.get(sessionId);
    if (pending) {
      await pending;
      return;
    }
    const promise = lockOnce(sessionId, embeddingOptions(apiKeys)).finally(
      () => {
        inflight.delete(sessionId);
      },
    );
    inflight.set(sessionId, promise);
    await promise;
  };
}

/** Shared retrieval/ingestion services inherit keys and model settings through async request scope. */
export function createMemoryEmbed(opts: {
  ai: Pick<AiStack, "gateway">;
  apiKeys?: Record<string, string>;
}): EmbedFn {
  return async (texts, context) => {
    const options = embeddingOptions(opts.apiKeys);
    const target = resolveEmbedding(opts.ai, options);
    if (!target || embeddingModelIdentity(target) !== context.modelId) {
      throw new EmbeddingModelChangedError(
        "Embedding configuration changed for this session; restore its locked model settings or rebuild its memory index.",
      );
    }
    const result = await opts.ai.gateway.embed(
      {
        presetId: embeddingRole(options),
        values: [...texts],
        expectedModelId: `${target.provider}/${target.model}`,
        expectedConfiguration: embeddingConfiguration(target),
      },
      options,
    );
    return result.embeddings.map((vector) => Float32Array.from(vector));
  };
}
