/**
 * Sprite layer for stage mode (spec §2 `StageSprites`). Stations
 * `computeSpriteSlots`' output across the stage, brightening the primary
 * speaker and dimming the rest. Entrance is a CSS keyframe (opacity +
 * translateY); the active/inactive filter and scale live on an *inner*
 * element so they never fight the entrance animation for control of
 * `transform` (see the `.ui-stage-rise-in` comment in index.css).
 */
import { clsx } from "clsx";
import { useRef, type ReactElement } from "react";
import { Media } from "@/components/Media.js";
import {
  computeSpriteSlots,
  type PresenceRecord,
  type SpritePosition,
  type StageSpeaker,
} from "./stage-selectors.js";

export interface StageSpritesProps {
  readonly speakers: readonly StageSpeaker[];
  readonly presence: Readonly<Record<string, PresenceRecord | undefined>>;
  readonly sessionId: string;
}

const POSITION_OFFSET: Readonly<Record<SpritePosition, string>> = {
  left: "14%",
  "center-left": "34%",
  center: "50%",
  "center-right": "66%",
  right: "86%",
};

export function StageSprites({
  speakers,
  presence,
  sessionId,
}: StageSpritesProps): ReactElement {
  const fresh = computeSpriteSlots(speakers, presence);
  // GalGame sticky sprites: transitional narration turns often have no active
  // cast — keep the previous line-up on stage (dimmed) instead of blinking
  // everyone out, until a turn with a real cast replaces it.
  const lastSlotsRef = useRef(fresh);
  if (fresh.length > 0) lastSlotsRef.current = fresh;
  const sticky = fresh.length === 0 && lastSlotsRef.current.length > 0;
  const slots = sticky
    ? lastSlotsRef.current.map((slot) => ({ ...slot, active: false }))
    : fresh;

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 bottom-[26%]"
      data-testid="stage-sprites"
    >
      {slots.map((slot) => (
        <div
          key={slot.characterId}
          className="ui-stage-sprite absolute bottom-0 h-full"
          style={{ left: POSITION_OFFSET[slot.pos] }}
        >
          <div
            className={clsx(
              "flex h-full items-end justify-center transition-[filter,transform] duration-300 ease-out",
              slot.active
                ? "ui-stage-sprite-active"
                : "ui-stage-sprite-inactive",
            )}
          >
            <Media
              src={slot.ref}
              sessionId={sessionId}
              alt={slot.displayName}
              fit="contain"
              rounded="none"
              maxHeight="100%"
            />
          </div>
        </div>
      ))}
    </div>
  );
}
