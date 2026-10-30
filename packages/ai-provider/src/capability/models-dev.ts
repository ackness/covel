/**
 * Request options of models as models.dev publishes them per host
 * (https://github.com/sst/models.dev, MIT): reasoning controls, sampling
 * parameters a model fixes itself, and tool choices per protocol.
 *
 * `models-dev.data.json` is a trimmed snapshot written by
 * `scripts/update-models-dev.ts`. It is the default source for these facts;
 * `reasoning-models.data.json` only corrects or extends it.
 */

import bundledData from "./models-dev.data.json" with { type: "json" };

/** A models.dev effort level. */
export type ModelsDevEffort =
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** One way hosts serve a model; hosts that serve it alike share it. */
export interface ModelsDevVariant {
  /** models.dev provider IDs. */
  providers: string[];
  /** API hosts of those providers, lower-cased. */
  hosts: string[];
  /** The provider ID of the lab that made the model. */
  lab?: string;
  reasoning?: {
    /** Thinking can be switched on and off. */
    toggle?: true;
    effort?: ModelsDevEffort[];
    /** The level used when a request names none; `on`/`off` for a toggle. */
    default?: ModelsDevEffort | "on" | "off";
  };
  /** Sampling parameters the model does not take. */
  fixed?: Array<"temperature" | "top_p">;
  /** Tool choices accepted, by models.dev API name. */
  toolChoice?: Partial<
    Record<"chat-completions" | "responses" | "messages", string[]>
  >;
}

export interface ModelsDevFile {
  source: string;
  /** The models.dev license notice, kept with the data it covers. */
  license: string;
  /** models.dev commit at fetch time, when GitHub answered. */
  commit?: string;
  fetchedAt: string;
  /** Lower-cased model ID → the ways hosts serve it. */
  models: Record<string, ModelsDevVariant[]>;
}

const data = bundledData as ModelsDevFile;

/** Covel protocol → models.dev API name. */
export const MODELS_DEV_API: Readonly<
  Record<string, "chat-completions" | "responses" | "messages">
> = {
  "openai-chat-v1": "chat-completions",
  "openai-responses-v1": "responses",
  "anthropic-messages-v1": "messages",
};

/** Where a request goes, as far as the caller knows. */
export interface ModelsDevTarget {
  /** Covel provider name of the slot. */
  provider?: string;
  /** The slot's base URL. */
  baseUrl?: string;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** A dated or pinned snapshot suffix: `-2026-09-22`, `-20251001`, `@default`. */
const SNAPSHOT_SUFFIX = /(?:-\d{4}-\d{2}-\d{2}|-\d{8}|@[\w.-]+)$/;

/**
 * The models.dev entry for a model at a target. The model ID is tried whole,
 * then without an aggregator prefix (`deepseek/deepseek-v4-flash`), then
 * without a snapshot suffix (`gpt-6-luna-2026-09-22`). Among the
 * hosts that serve it, the one at the slot's base URL wins, then one whose
 * provider ID is the slot's provider, then the lab's own, then the entry most
 * hosts share.
 */
export function modelsDevVariant(
  modelId: string,
  target: ModelsDevTarget = {},
): ModelsDevVariant | undefined {
  const id = modelId.toLowerCase();
  const tail = id.slice(id.lastIndexOf("/") + 1);
  const variants =
    data.models[id] ??
    data.models[tail] ??
    data.models[tail.replace(SNAPSHOT_SUFFIX, "")];
  if (!variants?.length) return undefined;
  const host = hostOf(target.baseUrl);
  const provider = target.provider?.toLowerCase();
  return (
    (host && variants.find((entry) => entry.hosts.includes(host))) ||
    (provider &&
      variants.find((entry) => entry.providers.includes(provider))) ||
    variants.find(
      (entry) => entry.lab && entry.providers.includes(entry.lab),
    ) ||
    [...variants].sort((a, b) => b.providers.length - a.providers.length)[0]
  );
}

/** When and from where the bundled snapshot was taken. */
export function modelsDevSnapshot(): Omit<ModelsDevFile, "models"> {
  const { models: _models, ...meta } = data;
  return meta;
}
