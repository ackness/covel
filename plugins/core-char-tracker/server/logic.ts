// ── Types ─────────────────────────────────────────────────────────

export interface TrackerExtension {
  firstSeenTurn: string;
  lastSeenTurn: string;
  mood?: string;
  mentionCount: number;
}

// ── Constants ─────────────────────────────────────────────────────

export const PLUGIN_ID = "core-char-tracker";
