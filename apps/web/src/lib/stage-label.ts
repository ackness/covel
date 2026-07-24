import type { Stage } from "@covel/shared";

type Translate = (key: string, fallback: string) => string;

/**
 * Player-facing localized labels for the named execution stages. Replaces the
 * old `P{priority}` numeric badges. Keys live under `session.stage.*`.
 */
export const STAGE_LABELS: Record<Stage, { key: string; fallback: string }> = {
  setup: { key: "session.stage.setup", fallback: "Setup" },
  "pre-turn": { key: "session.stage.pre-turn", fallback: "Pre-Turn" },
  narrative: { key: "session.stage.narrative", fallback: "Narrative" },
  "post-turn": { key: "session.stage.post-turn", fallback: "Post-Turn" },
  audit: { key: "session.stage.audit", fallback: "Audit" },
};

/** Localized stage label, or `undefined` for stage-less (event/manual) runtimes. */
export function stageLabel(
  stage: Stage | undefined,
  t: Translate,
): string | undefined {
  if (stage === undefined) return undefined;
  const entry = STAGE_LABELS[stage];
  return t(entry.key, entry.fallback);
}
