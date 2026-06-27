/**
 * Single source of truth for the framework's hook lifecycle.
 *
 * `HOOK_EVENTS` is the ONLY place the 16 hook event names are enumerated.
 * Everything else derives from this tuple so the contract cannot drift:
 *
 *  - `HookEventName` (below)            — the union type, `typeof HOOK_EVENTS[number]`.
 *  - `@covel/runtime`'s `HookEvent`     — re-derived from `HOOK_EVENTS` in
 *                                         `packages/runtime/src/hooks/types.ts`.
 *  - `HOOK_SEMANTICS` (runtime)         — `Record<HookEvent, …>`, so TypeScript
 *                                         forces a semantic for every event here.
 *  - `VALID_HOOK_EVENTS` (plugin loader + plugin-schemas) — validation sets are
 *                                         built from this tuple, never hand-listed.
 *
 * The order mirrors the turn-pipeline lifecycle documented in
 * docs/reference/plugins.md. Order has no functional meaning — events are keyed,
 * not indexed — so reordering is safe, but keeping lifecycle order aids reading.
 */
export const HOOK_EVENTS = [
  "SessionStart",
  "TurnStart",
  "PreCompaction",
  "PostCompaction",
  "PreSchedule",
  "PreRuntime",
  "PostContextAssembly",
  "PreLLMCall",
  "PostLLMResponse",
  "PostRuntime",
  "PreToolUse",
  "PostToolUse",
  "PreStateCommit",
  "PostStateCommit",
  "TurnStop",
  "SessionEnd",
] as const;

/**
 * Hook event names a plugin runtime can register handlers for.
 * Derived from {@link HOOK_EVENTS} — do not re-list the literals anywhere.
 */
export type HookEventName = (typeof HOOK_EVENTS)[number];

/** Ordering group for a hook handler within an event. */
export type HookEnforce = "pre" | "normal" | "post";

/**
 * Single hook declaration in PLUGIN.md frontmatter.
 * Handler files are resolved lazily — no eager import at parse time.
 */
export interface HookDeclaration {
  readonly event: HookEventName;
  /** Relative path to the handler module inside the plugin package. */
  readonly handler: string;
  /** Optional simple equality filter: { tool: "my-tool" } etc. */
  readonly match?: Readonly<Record<string, string | number>>;
  /** Per-handler timeout in ms. Default 5000. */
  readonly timeoutMs?: number;
  /** Ordering group. Default normal. */
  readonly enforce?: HookEnforce;
}
