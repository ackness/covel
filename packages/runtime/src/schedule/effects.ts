/**
 * Effects read/write-set derivation and same-layer hazard policy (01 §7).
 *
 * A runtime's read/write sets are derived from its declared surfaces — builtin
 * tools, `events` topics, `dataSchemas` namespaces, `outputKind`, `ui` — and
 * optionally supplemented by an explicit `effects` declaration. Two runtimes
 * scheduled in the SAME level (parallel group) are checked pairwise: a
 * read/write conflict with no ordering edge between them is a hazard. The
 * default policy warns and keeps running in parallel (today's behaviour); the
 * strict policy (opt-in via `COVEL_EFFECTS_POLICY=strict`) splits conflicting
 * pairs into serial sub-levels.
 *
 * Agent runtimes cannot be statically analysed for what their LLM will call, so
 * their derivation is based purely on the same declared surfaces — an agent
 * that declares no builtin tools derives an empty set. We deliberately do NOT
 * inject `unknown:*` for undeclared agents (that would make every same-layer
 * agent hazard against every other and drown the diagnostics).
 */

import type {
  EffectResource,
  RuntimeManifest,
  SchedulingDiagnostic,
} from "@covel/shared";
import { getRuntimeSpec } from "@covel/shared";
import type { ScheduledGroup } from "../types.js";

/** Derived read/write sets plus the author's `parallelSafe` opt-in. */
export interface RuntimeEffects {
  readonly reads: ReadonlySet<EffectResource>;
  readonly writes: ReadonlySet<EffectResource>;
  readonly parallelSafe: boolean;
}

// Builtin tools whose invocation writes a fixed domain resource.
const BUILTIN_WRITE: Readonly<Record<string, EffectResource>> = {
  "create-character": "characters:*",
  "update-character": "characters:*",
  "memory-update-block": "working-memory:*",
  "render-ui": "ui:*",
  "create-notification": "ui:*",
  "create-form": "interaction:*",
  "create-choices": "interaction:*",
};

// Builtin tools whose invocation reads a fixed domain resource.
const BUILTIN_READ: Readonly<Record<string, EffectResource>> = {
  "list-characters": "characters:*",
  "get-character": "characters:*",
  "world-dimension-get": "state:*",
};

/**
 * Derive the read/write sets for a runtime from its declared surfaces.
 *
 * plugin-data keys use the `plugin-data:self:<ns>` literal from the design
 * vocabulary. Intersection is pure string equality (see `resourcesIntersect`),
 * so two DIFFERENT plugins that both declare a `state` namespace produce the
 * same key and read as a (false-positive) hazard even though plugin-data is
 * isolated per plugin. This is the documented conservative posture (safe: never
 * misses a real hazard); the default warn policy makes it harmless and
 * `parallelSafe` / strict are the escape hatches.
 * ponytail: string-equality on the `self` literal over-matches cross-plugin;
 * resolve `self`→pluginId here if the false positives get noisy in practice.
 */
export function deriveEffects(manifest: RuntimeManifest): RuntimeEffects {
  const reads = new Set<EffectResource>();
  const writes = new Set<EffectResource>();
  const builtinTools = manifest.tools?.builtin ?? [];

  for (const t of builtinTools) {
    const w = BUILTIN_WRITE[t];
    if (w) writes.add(w);
    const r = BUILTIN_READ[t];
    if (r) reads.add(r);
  }

  // plugin-data: declared dataSchemas namespaces → per-ns self keys; an
  // undeclared namespace collapses to the conservative `unknown:*` global write.
  const dataNamespaces = Object.keys(manifest.dataSchemas ?? {});
  const pluginDataKeys: readonly EffectResource[] =
    dataNamespaces.length > 0
      ? dataNamespaces.map((ns) => `plugin-data:self:${ns}` as EffectResource)
      : ["unknown:*"];
  if (
    builtinTools.includes("plugin-data-set") ||
    builtinTools.includes("plugin-data-set-batch")
  ) {
    for (const k of pluginDataKeys) writes.add(k);
  }
  if (
    builtinTools.includes("plugin-data-get") ||
    builtinTools.includes("plugin-data-list")
  ) {
    for (const k of pluginDataKeys) reads.add(k);
  }

  // emit-event: one write key per declared topic; no declared topics → the
  // conservative `event:*` wildcard.
  if (builtinTools.includes("emit-event")) {
    const topics = (manifest.events ?? []).map((e) => e.topic);
    if (topics.length > 0) {
      for (const topic of topics)
        writes.add(`event:${topic}` as EffectResource);
    } else {
      writes.add("event:*" as EffectResource);
    }
  }

  // outputKind: story runtimes write the narrative stream. Declared UI panels
  // imply ui writes (conservative — better over-declared than a missed hazard).
  if (manifest.outputKind === "story") writes.add("narrative:*");
  if (manifest.ui) writes.add("ui:*");

  // Explicit `effects` is UNIONed with the derivation (v1 rule): an author may
  // ADD or tighten reads+writes but can never REMOVE a derived resource, so a
  // narrower declaration cannot hide a real hazard. `parallelSafe` is the only
  // way to exempt a pair (pure W/W, see `effectsHazard`).
  const decl = getRuntimeSpec(manifest).effectsDecl;
  for (const r of decl?.reads ?? []) reads.add(r);
  for (const w of decl?.writes ?? []) writes.add(w);

  return { reads, writes, parallelSafe: decl?.parallelSafe ?? false };
}

/**
 * Two resource keys intersect when they are identical, when either is the
 * conservative `unknown:*` global write, or when one is a namespace wildcard
 * (`<ns>:*`) and the other shares that namespace prefix (01 §7).
 */
export function resourcesIntersect(
  a: EffectResource,
  b: EffectResource,
): boolean {
  if (a === b) return true;
  if (a === "unknown:*" || b === "unknown:*") return true;
  // A trailing `:*` is a namespace wildcard: strip the star and prefix-match.
  if (a.endsWith(":*") && b.startsWith(a.slice(0, -1))) return true;
  if (b.endsWith(":*") && a.startsWith(b.slice(0, -1))) return true;
  return false;
}

function intersectsSets(
  left: ReadonlySet<EffectResource>,
  right: ReadonlySet<EffectResource>,
): boolean {
  for (const a of left) {
    for (const b of right) {
      if (resourcesIntersect(a, b)) return true;
    }
  }
  return false;
}

/**
 * Same-layer hazard between two runtimes (01 §7):
 *   intersects(W_A, R_B ∪ W_B) || intersects(W_B, R_A ∪ W_A)
 * R/R is always safe. When both runtimes opt into `parallelSafe` and the ONLY
 * overlap is pure W/W with no `unknown:*`, the pair is exempted (the authors
 * assert their writes commute); `parallelSafe` never exempts a W/R or R/W
 * hazard, and strict operator policy can still serialize an exempted pair.
 */
export function effectsHazard(a: RuntimeEffects, b: RuntimeEffects): boolean {
  const aRW = new Set<EffectResource>([...a.reads, ...a.writes]);
  const bRW = new Set<EffectResource>([...b.reads, ...b.writes]);
  const hazard = intersectsSets(a.writes, bRW) || intersectsSets(b.writes, aRW);
  if (!hazard) return false;

  const exempt =
    a.parallelSafe &&
    b.parallelSafe &&
    // No write-vs-read conflict in either direction (pure W/W only).
    !intersectsSets(a.writes, b.reads) &&
    !intersectsSets(b.writes, a.reads) &&
    // The W/W overlap must not involve the global `unknown:*` write.
    !a.writes.has("unknown:*") &&
    !b.writes.has("unknown:*");
  return !exempt;
}

// ── Policy application ───────────────────────────────────────────

export type EffectsPolicy = "warn" | "strict";

export interface HazardPolicyResult {
  readonly groups: readonly ScheduledGroup[];
  readonly diagnostics: readonly SchedulingDiagnostic[];
}

/**
 * Resolve the operator's effects hazard policy. Default `warn` (today's
 * behaviour: diagnostics only, keep running in parallel); `strict` splits
 * conflicting pairs into serial sub-levels. Registered in
 * docs/guide/env-registry.md.
 */
export function resolveEffectsPolicy(
  env: Record<string, string | undefined> = process.env,
): EffectsPolicy {
  return env.COVEL_EFFECTS_POLICY === "strict" ? "strict" : "warn";
}

/**
 * Apply the hazard policy to already-scheduled groups. Each group is a set of
 * runtimes the scheduler placed in the same level (fully parallel). Pairs are
 * enumerated in stable (name-sorted) order so the diagnostics and any strict
 * re-layering are deterministic for a given input.
 *
 * `warn`: emit one diagnostic per hazard pair, keep the group intact.
 * `strict`: emit the diagnostics AND split the group into ordered sub-levels
 * (greedy longest-conflict-chain colouring in stable id order) so no hazard
 * pair runs concurrently — without adding DAG edges or risking a cycle.
 */
export function applyHazardPolicy(
  groups: readonly ScheduledGroup[],
  policy: EffectsPolicy,
): HazardPolicyResult {
  const diagnostics: SchedulingDiagnostic[] = [];
  const outGroups: ScheduledGroup[] = [];

  for (const group of groups) {
    if (group.runtimes.length < 2) {
      outGroups.push(group);
      continue;
    }

    const sorted = [...group.runtimes].sort((x, y) =>
      x.name.localeCompare(y.name),
    );
    const effectsByName = new Map<string, RuntimeEffects>();
    for (const rt of sorted) effectsByName.set(rt.name, deriveEffects(rt));

    const hazardPairs: Array<readonly [string, string]> = [];
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = effectsByName.get(sorted[i]!.name)!;
        const b = effectsByName.get(sorted[j]!.name)!;
        if (effectsHazard(a, b)) {
          hazardPairs.push([sorted[i]!.name, sorted[j]!.name]);
        }
      }
    }

    if (hazardPairs.length === 0) {
      outGroups.push(group);
      continue;
    }

    for (const [x, y] of hazardPairs) {
      diagnostics.push({
        code: "effects-hazard",
        severity: "warn",
        message: `same-layer effects hazard between ${x} and ${y} (policy: ${policy})`,
        data: { a: x, b: y, policy },
      });
    }

    if (policy === "warn") {
      outGroups.push(group);
    } else {
      for (const sub of strictSerialize(sorted, effectsByName)) {
        outGroups.push(sub);
      }
    }
  }

  return { groups: outGroups, diagnostics };
}

/**
 * Split one parallel group into ordered sub-levels so no hazard pair shares a
 * level. `level[node] = 1 + max(level[prior])` over already-placed conflicting
 * nodes in stable id order — a conflicting pair `A < B` always lands with
 * `level[B] > level[A]`, so it is serialized in id order; independent nodes
 * share a level and stay parallel. O(n²) over the (small) group, deterministic.
 */
function strictSerialize(
  sorted: readonly RuntimeManifest[],
  effectsByName: ReadonlyMap<string, RuntimeEffects>,
): readonly ScheduledGroup[] {
  const levelOf = new Map<string, number>();
  for (let i = 0; i < sorted.length; i++) {
    const rt = sorted[i]!;
    let lvl = 0;
    for (let j = 0; j < i; j++) {
      const prior = sorted[j]!;
      if (
        effectsHazard(
          effectsByName.get(rt.name)!,
          effectsByName.get(prior.name)!,
        )
      ) {
        lvl = Math.max(lvl, levelOf.get(prior.name)! + 1);
      }
    }
    levelOf.set(rt.name, lvl);
  }

  const maxLevel = Math.max(0, ...levelOf.values());
  const buckets: RuntimeManifest[][] = Array.from(
    { length: maxLevel + 1 },
    () => [],
  );
  for (const rt of sorted) buckets[levelOf.get(rt.name)!]!.push(rt);
  return buckets.map((runtimes) => ({ runtimes }));
}
