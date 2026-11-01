import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useMediaQuery } from "@/hooks/use-media-query.js";
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

interface OutgoingSprite extends DisplayedSprite {
  readonly generation: number;
  readonly deadline: number;
}

interface SpriteState {
  readonly sessionId: string;
  readonly stations: ReadonlyMap<string, SpritePosition>;
  readonly live: readonly DisplayedSprite[];
  readonly outgoing: readonly OutgoingSprite[];
  readonly explicit: ReadonlySet<string>;
  readonly generation: number;
}

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

function emptyState(sessionId: string, generation = 0): SpriteState {
  return {
    sessionId,
    stations: new Map(),
    live: [],
    outgoing: [],
    explicit: new Set(),
    generation,
  };
}

/** Reconcile committed pixels only. Outgoing geometry never enters live selection. */
function reconcile(
  previous: SpriteState,
  { speakers, presence, sessionId, retainWhenEmpty = true }: StageSpritesProps,
  reducedMotion: boolean,
  now: number,
): SpriteState {
  const old =
    previous.sessionId === sessionId
      ? previous
      : emptyState(sessionId, previous.generation);
  const current = speakers.filter((speaker) => !speaker.exiting);
  const stations = assignStations(
    old.stations,
    current.map(({ id }) => id),
  );
  const fresh = computeSpriteSlots(current, presence, stations);
  const lanes = computeSpriteLanes(fresh.map(({ pos }) => pos));
  // An explicit clear contains exit actors, so it must never become sticky.
  const sticky = speakers.length === 0 && retainWhenEmpty;
  const live = sticky
    ? old.live.map(({ slot, lane }) => ({
        slot: { ...slot, active: false },
        lane,
      }))
    : fresh.map((slot, index) => ({ slot, lane: lanes[index]! }));
  const liveIds = new Set(live.map(({ slot }) => slot.characterId));
  const explicit = new Set(old.explicit);
  for (const id of liveIds) explicit.delete(id);
  let generation = old.generation;
  let outgoing = old.outgoing.filter(
    ({ slot }) => !liveIds.has(slot.characterId),
  );
  const admit = (displayed: DisplayedSprite, transition: StageTransition) => {
    if (reducedMotion || transition === "none") return;
    outgoing.push({
      ...displayed,
      slot: { ...displayed.slot, active: false, exiting: true, transition },
      generation: ++generation,
      deadline: now + EXIT_DEADLINES[transition],
    });
  };
  for (const speaker of speakers.filter((entry) => entry.exiting)) {
    if (explicit.has(speaker.id) || liveIds.has(speaker.id)) continue;
    explicit.add(speaker.id);
    // A newly delivered explicit cue overrides an inferred departure. Duplicate
    // explicit snapshots were consumed above, including completed/cut exits.
    const displayed =
      old.live.find(({ slot }) => slot.characterId === speaker.id) ??
      old.outgoing.find(({ slot }) => slot.characterId === speaker.id);
    outgoing = outgoing.filter(({ slot }) => slot.characterId !== speaker.id);
    const slot = computeSpriteSlots([speaker], presence, old.stations)[0];
    if (slot)
      admit(
        {
          slot: slot.ref ? slot : (displayed?.slot ?? slot),
          lane: displayed?.lane ?? computeSpriteLanes([slot.pos])[0]!,
        },
        speaker.transition ?? "fade",
      );
  }
  for (const displayed of old.live) {
    const id = displayed.slot.characterId;
    if (
      liveIds.has(id) ||
      explicit.has(id) ||
      outgoing.some(({ slot }) => slot.characterId === id)
    )
      continue;
    // A remembered entrance transition is never an exit instruction.
    admit(displayed, "fade");
  }
  outgoing = reducedMotion ? [] : outgoing.slice(-MAX_SPRITE_SLOTS);
  return { sessionId, stations, live, outgoing, explicit, generation };
}

/** Timers and reconciliation run after commit, including in StrictMode. */
export function useStageSpriteTransitions(props: StageSpritesProps) {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [state, setState] = useState(() => emptyState(props.sessionId));
  const committed = useRef(state);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const { speakers, presence, sessionId, retainWhenEmpty } = props;

  useLayoutEffect(() => {
    const next = reconcile(
      committed.current,
      { speakers, presence, sessionId, retainWhenEmpty },
      reducedMotion,
      Date.now(),
    );
    committed.current = next;
    setState(next);
  }, [speakers, presence, sessionId, retainWhenEmpty, reducedMotion]);

  const finish = useCallback((generation: number) => {
    const old = committed.current;
    if (!old.outgoing.some((entry) => entry.generation === generation)) return;
    const next = {
      ...old,
      outgoing: old.outgoing.filter((entry) => entry.generation !== generation),
    };
    committed.current = next;
    setState(next);
  }, []);

  useLayoutEffect(() => {
    const pending = new Set(state.outgoing.map(({ generation }) => generation));
    for (const [generation, timer] of timers.current) {
      if (pending.has(generation)) continue;
      clearTimeout(timer);
      timers.current.delete(generation);
    }
    for (const { generation, deadline } of state.outgoing) {
      if (timers.current.has(generation)) continue;
      timers.current.set(
        generation,
        setTimeout(
          () => finish(generation),
          Math.max(0, deadline - Date.now()),
        ),
      );
    }
  }, [state.outgoing, finish]);

  useLayoutEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  return {
    live: state.sessionId === sessionId ? state.live : [],
    outgoing: state.sessionId === sessionId ? state.outgoing : [],
    finish,
  };
}
