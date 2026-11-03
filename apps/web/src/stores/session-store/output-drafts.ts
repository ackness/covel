/**
 * Story drafts: what a story runtime has written so far, shown before the
 * turn commits. Drafts are live-only; they are never stored, restored or
 * sent anywhere, and a committed story always replaces them.
 */
import { z } from "zod";
import type { StreamMessage } from "./types.js";

/** How early the player wants to read: written text, finished lines, or the commit. */
export const LIVE_OUTPUT_PREFERENCES = ["text", "units", "committed"] as const;
export type LiveOutputPreference = (typeof LIVE_OUTPUT_PREFERENCES)[number];

const metaValue = z.union([z.string(), z.number(), z.boolean()]);
const unitSchema = z.object({
  text: z.string(),
  meta: z.record(z.string(), metaValue).optional(),
});
export type OutputDraftUnit = z.infer<typeof unitSchema>;

const identity = {
  turnId: z.string().min(1),
  runtimeId: z.string().min(1),
  pluginId: z.string(),
  draftId: z.string().min(1),
};
const draftPayload = z.object({
  ...identity,
  mode: z.enum(["units", "text"]),
  units: z.array(unitSchema),
  partial: unitSchema.optional(),
});
const retractedPayload = z.object({
  ...identity,
  reason: z.enum(["revising", "stopped"]),
});
const acceptedPayload = z.object({ ...identity, units: z.array(unitSchema) });

export interface OutputDraft {
  readonly turnId: string;
  readonly runtimeId: string;
  readonly pluginId: string;
  readonly draftId: string;
  readonly units: readonly OutputDraftUnit[];
  /** The line being written, in text mode only. */
  readonly partial?: OutputDraftUnit;
  /** The runtime accepted it; only the commit is missing. */
  readonly accepted: boolean;
  /** What was shown is void and the model is trying again. */
  readonly revising: boolean;
}

export type OutputDraftAction =
  | { type: "OUTPUT_DRAFT"; draft: OutputDraft }
  | {
      type: "OUTPUT_DRAFT_RETRACTED";
      turnId: string;
      runtimeId: string;
      draftId: string;
      reason: "revising" | "stopped";
    }
  | { type: "CLEAR_OUTPUT_DRAFT"; turnId: string; runtimeId: string }
  | { type: "CLEAR_OUTPUT_DRAFTS"; turnId?: string };

/** Reads an `output.*` wire event; anything malformed is ignored. */
export function outputDraftAction(
  type: "output.draft" | "output.retracted" | "output.accepted",
  payload: unknown,
): OutputDraftAction | undefined {
  if (type === "output.retracted") {
    const parsed = retractedPayload.safeParse(payload);
    if (!parsed.success) return undefined;
    const { turnId, runtimeId, draftId, reason } = parsed.data;
    return {
      type: "OUTPUT_DRAFT_RETRACTED",
      turnId,
      runtimeId,
      draftId,
      reason,
    };
  }
  if (type === "output.accepted") {
    const parsed = acceptedPayload.safeParse(payload);
    if (!parsed.success) return undefined;
    return {
      type: "OUTPUT_DRAFT",
      draft: { ...parsed.data, accepted: true, revising: false },
    };
  }
  const parsed = draftPayload.safeParse(payload);
  if (!parsed.success) return undefined;
  const { mode: _mode, partial, ...draft } = parsed.data;
  return {
    type: "OUTPUT_DRAFT",
    draft: {
      ...draft,
      ...(partial ? { partial } : {}),
      accepted: false,
      revising: false,
    },
  };
}

const sameRuntime = (
  draft: OutputDraft,
  turnId: string,
  runtimeId: string,
): boolean => draft.turnId === turnId && draft.runtimeId === runtimeId;

export function reduceOutputDrafts(
  drafts: readonly OutputDraft[],
  action: OutputDraftAction,
): readonly OutputDraft[] {
  switch (action.type) {
    case "OUTPUT_DRAFT": {
      const { draft } = action;
      const index = drafts.findIndex((entry) =>
        sameRuntime(entry, draft.turnId, draft.runtimeId),
      );
      if (index < 0) return [...drafts, draft];
      const next = [...drafts];
      next[index] = draft;
      return next;
    }
    case "OUTPUT_DRAFT_RETRACTED": {
      const index = drafts.findIndex((entry) =>
        sameRuntime(entry, action.turnId, action.runtimeId),
      );
      const current = drafts[index];
      if (!current || current.draftId !== action.draftId) return drafts;
      if (action.reason === "stopped")
        return drafts.filter((_, at) => at !== index);
      const { partial: _partial, ...rest } = current;
      const next = [...drafts];
      next[index] = { ...rest, units: [], accepted: false, revising: true };
      return next;
    }
    case "CLEAR_OUTPUT_DRAFT": {
      const next = drafts.filter(
        (draft) => !sameRuntime(draft, action.turnId, action.runtimeId),
      );
      return next.length === drafts.length ? drafts : next;
    }
    case "CLEAR_OUTPUT_DRAFTS": {
      if (drafts.length === 0) return drafts;
      if (action.turnId === undefined) return [];
      const next = drafts.filter((draft) => draft.turnId !== action.turnId);
      return next.length === drafts.length ? drafts : next;
    }
  }
}

/** The units a player with this preference sees, or undefined for none. */
export function visibleDraftUnits(
  draft: OutputDraft,
  preference: LiveOutputPreference,
): readonly OutputDraftUnit[] | undefined {
  if (preference === "committed") return undefined;
  const units =
    preference === "text" && draft.partial
      ? [...draft.units, draft.partial]
      : draft.units;
  return units.length > 0 ? units : undefined;
}

/**
 * The draft as a story message, so it renders exactly like the story it
 * becomes. The id is stable for the runtime's turn, not for one draft.
 */
export function draftStoryMessage(
  draft: OutputDraft,
  units: readonly OutputDraftUnit[],
): StreamMessage {
  const segmented = units.some((unit) => typeof unit.meta?.kind === "string");
  return {
    id: `draft:${draft.turnId}:${draft.runtimeId}`,
    role: "assistant",
    kind: "story",
    content: units.map((unit) => unit.text).join("\n\n"),
    timestamp: "",
    turnId: draft.turnId,
    runtimeId: draft.runtimeId,
    ...(segmented
      ? {
          segments: units.map((unit) => {
            const kind = unit.meta?.kind;
            const speaker = unit.meta?.speaker;
            return {
              kind:
                kind === "dialogue" || kind === "action" ? kind : "narration",
              text: unit.text,
              ...(typeof speaker === "string" && speaker ? { speaker } : {}),
            };
          }),
        }
      : {}),
  };
}

/** True when the player already read this story as a draft. */
export function draftWasShown(
  drafts: readonly OutputDraft[],
  turnId: string,
  runtimeId: string,
  preference: LiveOutputPreference,
): boolean {
  const draft = drafts.find((entry) => sameRuntime(entry, turnId, runtimeId));
  return (
    draft !== undefined && visibleDraftUnits(draft, preference) !== undefined
  );
}

/** The stored preference, or the default for anything else. */
export function readLiveOutputPreference(value: unknown): LiveOutputPreference {
  return LIVE_OUTPUT_PREFERENCES.find((entry) => entry === value) ?? "units";
}
