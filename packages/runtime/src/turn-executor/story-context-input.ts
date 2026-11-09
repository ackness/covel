import {
  selectStoryContext,
  storyContextBudget,
  type StoryContextCandidate,
  type StoryContextSelection,
} from "@covel/context";
import {
  estimateTokens,
  resolveI18nText,
  type JsonValue,
  type RuntimeManifest,
  type RuntimeResult,
} from "@covel/shared";
import { resolveJsonPointer } from "../schedule/accepts-compat.js";
import { freezeSnapshot } from "./turn-digest.js";

/**
 * The `story-context@1` value of one reader, built like `operations@1`: from
 * the completed results of this execution and the retry seeds, with no
 * scheduling edge. Only successful runs of pre-turn runtimes that declare
 * `storyContext` contribute; the stage barrier has settled them before any
 * reader starts. A runtime that ran again this execution replaces its seed,
 * since both share one entry of `results`.
 *
 * `producerIds` are the run IDs of this execution's providers whose note the
 * value carries: the reader depends on them at commit. Seeds are committed
 * already and add no dependency. The IDs stay out of the value.
 */
export function buildStoryContextInput(params: {
  readonly results: ReadonlyMap<string, RuntimeResult>;
  readonly seeds?: ReadonlySet<RuntimeResult>;
  readonly activeRuntimes: readonly RuntimeManifest[];
  /** The session content locale: default titles are display names in it. */
  readonly locale?: string;
  /** Input tokens of the story model after its output reserve, when known. */
  readonly inputWindow?: number;
}): {
  readonly value: JsonValue;
  readonly producerIds: readonly string[];
  readonly selection: StoryContextSelection;
} {
  const manifests = new Map(
    params.activeRuntimes.map((manifest) => [manifest.name, manifest]),
  );
  const candidates: StoryContextCandidate[] = [];
  const producerOf = new Map<StoryContextCandidate, string>();
  for (const result of params.results.values()) {
    if (result.status !== "success") continue;
    const manifest = manifests.get(result.runtimeId);
    const spec = manifest?.storyContext;
    if (!manifest || !spec || manifest.stage !== "pre-turn") continue;
    const output = result.canonicalValue
      ? result.canonicalValue.value
      : result.output;
    const selected = resolveJsonPointer(output, spec.select ?? "");
    const candidate: StoryContextCandidate = {
      source: { pluginId: manifest.pluginId, runtimeId: manifest.name },
      ...(spec.priority ? { priority: spec.priority } : {}),
      ...(spec.order !== undefined ? { order: spec.order } : {}),
      defaultTitle: resolveI18nText(spec.title, params.locale) ?? "",
      value: selected.found ? selected.value : undefined,
      ...(manifest.concealed ? { concealed: true } : {}),
    };
    candidates.push(candidate);
    if (!params.seeds?.has(result)) producerOf.set(candidate, result.runId);
  }
  const selection = selectStoryContext(candidates, {
    budgetTokens: storyContextBudget(params.inputWindow),
    estimator: estimateTokens,
  });
  return {
    value: freezeSnapshot(
      structuredClone(selection.value) as unknown as JsonValue,
    ),
    producerIds: selection.included.flatMap((candidate) => {
      const runId = producerOf.get(candidate);
      return runId === undefined ? [] : [runId];
    }),
    selection,
  };
}
