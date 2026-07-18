/**
 * TurnMessage — the fundamental unit of conversation history.
 *
 * Messages are append-only: once written, never modified or deleted.
 * Each turn produces one or more messages (player input + runtime outputs).
 * Context assembly reads the message history and truncates from the front
 * based on token budget — this is a read-time view, not a write-time mutation.
 */

import type { UIRenderInstruction } from "./ui.js";

// ── Message source ───────────────────────────────────────────────

export type TurnMessageSourceType =
  "system" | "runtime" | "player" | "tool" | "player-input";

export interface TurnMessageSource {
  readonly type: TurnMessageSourceType;
  readonly pluginId?: string;
  readonly runtimeId?: string;
}

// ── Player input form (for interactive plugins) ──────────────────

export type PlayerInputFieldType =
  "text" | "textarea" | "select" | "checkbox" | "number";

export interface PlayerInputField {
  readonly type: PlayerInputFieldType;
  readonly name: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly options?: readonly string[];
  readonly required?: boolean;
  readonly defaultValue?: string;
}

export interface PlayerInputForm {
  readonly formId: string;
  readonly title: string;
  readonly fields: readonly PlayerInputField[];
  readonly submitLabel: string;
}

// ── TurnMessage ──────────────────────────────────────────────────

export interface TurnMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** Where this message came from. */
  readonly source: TurnMessageSource;
  /** LLM role for context assembly. */
  readonly role: "system" | "user" | "assistant";
  /** Display name (e.g., "narrator", "char-creator"). */
  readonly name?: string;
  /** Narrative text content (seen by LLM and player). */
  readonly content: string;
  /** UI render instructions (sent to frontend, NOT included in LLM context). */
  readonly ui?: readonly UIRenderInstruction[];
  /** Player input form request (blocks turn completion until submitted). */
  readonly pendingInput?: PlayerInputForm;
  /**
   * Ordering weight within a turn (lower = earlier).
   * Typically matches the runtime's priority.
   */
  readonly order: number;
  /** Append-only timestamp. */
  readonly createdAt: string;
}

// ── Player input submission ──────────────────────────────────────

export interface PlayerInputSubmission {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** Which form this submission responds to. */
  readonly formId: string;
  /** The values the player filled in. */
  readonly values: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

// ── Wire-format Message ──────────────────────────────────────────

/**
 * Wire-format `Message` — the contract returned by `/api/sessions/:id/messages`.
 *
 * This is a flattened, backwards-compatible projection used by frontend
 * chat lists and message replay. The richer `TurnMessage` (above) is the
 * authoritative server-side conversation type and is returned by the
 * `/turn-messages` endpoint when full UI render instructions are needed.
 */
export interface Message {
  readonly id: string;
  readonly sessionId: string;
  readonly role: string;
  readonly content: string;
  readonly turnId?: string;
  readonly runtimeId?: string;
  readonly kind?: string;
  readonly block?: unknown;
  readonly metadata?: unknown;
  readonly createdAt: string;
}
