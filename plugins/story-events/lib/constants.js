// Hidden buckets (accessible only to this plugin's own code).
export const HIDDEN_EVENTS = "_hidden.events";
export const PLANNED = "_hidden.planned";
export const JUDGMENTS = "_hidden.judgments";
export const ARMED = "_hidden.armed";
export const PENDING_OPTIONS = "_hidden.pending_options";
export const NARRATIVE_NOTES = "_hidden.narrative_notes";

// Public buckets (never store unrevealed payloads, hidden options, or hidden rewards).
export const REVEALED = "revealed";
export const ACTIVE_OPTIONS = "active_options";
export const SELECTED_OPTIONS = "selected_options";
export const CLAIMED_REWARDS = "claimed_rewards";
export const MESSAGE = "message";

// Cross-plugin versioned contracts discovered dynamically.
export const AFFINITY_TIER_CONTRACT = "affinity.tier@1";
export const INVENTORY_BAG_CONTRACT = "inventory.bag@2";
export const INVENTORY_CHANGE_CONTRACT = "inventory.change@1";
export const JUDGE_CONTRACT = "story-event.judge@1";
export const JUDGE_RUNTIME_ID = "story-events/judge";

// The value of `cueContext` in a turn with no event. Narrative prompts match
// this exact string, so it is a marker and is not translated.
export const NO_CUE = "No hidden story event this turn.";

export const DEFAULT_MAX_JUDGED = 8;
export const MAX_JUDGED_CAP = 16;
