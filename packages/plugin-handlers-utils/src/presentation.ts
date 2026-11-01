import type { StoryCues, StorySegment } from "./story-output.js";

/** The only story fields delivered to presentation code. */
export interface PresentationStory {
  readonly segments: readonly StorySegment[];
  readonly cues?: StoryCues;
}

export interface PresentationBudget {
  readonly calls: number;
  readonly generations: number;
}

export interface PresentationDeclaration {
  readonly budget?: Partial<PresentationBudget>;
}

export const PRESENTATION_REASONS = [
  "no-story",
  "no-scene-change",
  "asset-missing",
  "budget-exhausted",
  "unavailable",
  "superseded",
  "no-output",
  "failed",
] as const;

export type PresentationReason = (typeof PRESENTATION_REASONS)[number];

/** Identity for exact name resolution and display indexing, never profiles. */
export interface PresentationCharacter {
  readonly id: string;
  readonly name: string;
  readonly aliases?: readonly string[];
}

export interface PresentationContext {
  readonly characters: readonly PresentationCharacter[];
  readonly viewpointCharacterId?: string;
  /** A fixed diagnostic code, with no story, model reply or error text. */
  note(reason: PresentationReason): void;
}

/** A refused dispatch is a normal no-op; a handler may use existing assets. */
export class PresentationBudgetExhausted extends Error {
  override readonly name = "PresentationBudgetExhausted";
  readonly code = "budget-exhausted";
  constructor() {
    super("Presentation dispatch allowance exhausted");
  }
}
