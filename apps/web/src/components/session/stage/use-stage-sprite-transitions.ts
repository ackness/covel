import { useCallback } from "react";
import {
  hasStableDisplayKeys,
  useKeyedExitTransitions,
  type KeyedDisplaySnapshot,
} from "@/lib/use-keyed-exit-transitions.js";
import type { StageSpritesProps } from "./StageSprites.js";
import { MAX_SPRITE_SLOTS } from "./stage-direction-selectors.js";
import {
  assignStations,
  computeSpriteLanes,
  computeSpriteSlots,
  type SpritePosition,
  type StageSpriteSlot,
  type StageTransition,
} from "./stage-selectors.js";

interface DisplayedSprite {
  readonly slot: StageSpriteSlot;
  readonly lane: ReturnType<typeof computeSpriteLanes>[number];
}

type Stations = ReadonlyMap<string, SpritePosition>;
const initialStations: Stations = new Map();

export const EXIT_ANIMATIONS: Record<StageTransition, string> = {
  fade: "ui-stage-fade-out",
  "slide-left": "ui-stage-slide-to-left",
  "slide-right": "ui-stage-slide-to-right",
  dissolve: "ui-stage-dissolve-out",
  none: "",
};

// Match stage.css, with a small grace period for a missed animation event.
const EXIT_DEADLINES: Record<StageTransition, number> = {
  fade: 350,
  "slide-left": 370,
  "slide-right": 370,
  dissolve: 410,
  none: 0,
};

/** Geometry and explicit cues stay in the stage adapter; lifetimes are shared. */
export function useStageSpriteTransitions({
  speakers,
  presence,
  sessionId,
  retainWhenEmpty = true,
  exitTransition,
}: StageSpritesProps) {
  const resolve = useCallback(
    (old: KeyedDisplaySnapshot<DisplayedSprite, Stations>) => {
      const current = speakers.filter((speaker) => !speaker.exiting);
      const stations = assignStations(
        old.context,
        current.map(({ id }) => id),
      );
      const fresh = computeSpriteSlots(current, presence, stations);
      const lanes = computeSpriteLanes(fresh.map(({ pos }) => pos));
      // A valid transitional empty is sticky; explicit clear cues never are.
      const live =
        speakers.length === 0 && retainWhenEmpty
          ? old.live.map(({ key, value }) => ({
              key,
              value: {
                slot: { ...value.slot, active: false },
                lane: value.lane,
              },
            }))
          : fresh.map((slot, index) => ({
              key: slot.characterId,
              value: { slot, lane: lanes[index]! },
            }));
      const explicitExits = speakers
        .filter((speaker) => speaker.exiting)
        .map((speaker) => {
          const displayed =
            old.live.find(({ key }) => key === speaker.id)?.value ??
            old.outgoing.find(({ key }) => key === speaker.id)?.value;
          const slot = computeSpriteSlots([speaker], presence, old.context)[0]!;
          const transition = speaker.transition ?? "fade";
          return {
            key: speaker.id,
            value: {
              slot: {
                ...(slot.ref ? slot : (displayed?.slot ?? slot)),
                active: false,
                exiting: true,
                transition,
              },
              lane: displayed?.lane ?? computeSpriteLanes([slot.pos])[0]!,
            },
            animationName: EXIT_ANIMATIONS[transition],
            deadlineMs: EXIT_DEADLINES[transition],
          };
        });
      return {
        live,
        explicitExits,
        context: stations,
        validKeys: hasStableDisplayKeys(
          speakers.map(({ id }) => ({ key: id })),
        ),
      };
    },
    [speakers, presence, retainWhenEmpty],
  );
  const { live, outgoing, validKeys, finish } = useKeyedExitTransitions({
    scope: sessionId,
    initialContext: initialStations,
    resolve,
    exitTransition,
    maxOutgoing: MAX_SPRITE_SLOTS,
    inferredAnimationName: EXIT_ANIMATIONS.fade,
  });
  return {
    live: live.map(({ value }) => value),
    outgoing: outgoing.map(({ value, reason, generation }) => ({
      ...value,
      slot: {
        ...value.slot,
        active: false,
        exiting: true,
        transition:
          reason === "inferred" ? ("fade" as const) : value.slot.transition,
      },
      generation,
    })),
    validKeys,
    finish,
  };
}
