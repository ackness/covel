import type { StageBackdropModel, StageCastModel } from "@covel/shared";
import type { CharacterVisualRequest } from "@/lib/character-visuals.js";

export type StageCurrentRecord = StageBackdropModel;
export type SpritePosition = NonNullable<
  StageCastModel["actors"][number]["position"]
>;
export type StageTransition = NonNullable<
  StageCastModel["actors"][number]["transition"]
>;
export interface StageSpeaker {
  readonly id: string;
  readonly name: string;
  readonly visual?: CharacterVisualRequest;
  readonly active?: boolean;
  readonly position?: SpritePosition;
  readonly transition?: StageTransition;
  readonly exiting?: boolean;
}
export const MAX_SPRITE_SLOTS = 4;
