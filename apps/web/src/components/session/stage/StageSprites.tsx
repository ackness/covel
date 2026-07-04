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
  assignStations,
  computeSpriteLanes,
  computeSpriteSlots,
  type PresenceRecord,
  type SpritePosition,
  type StageSpeaker,
} from "./stage-selectors.js";

export interface StageSpritesProps {
  readonly speakers: readonly StageSpeaker[];
  readonly presence: Readonly<Record<string, PresenceRecord | undefined>>;
  readonly sessionId: string;
  /** Choice overlay open — pull focus off the sprites (classic VN dim). */
  readonly dimmed?: boolean;
}

export function StageSprites({
  speakers,
  presence,
  sessionId,
  dimmed = false,
}: StageSpritesProps): ReactElement {
  // Sticky stations: characters keep their spot while on stage; salience
  // only moves the highlight. The memory map lives in a ref updated during
  // render — deterministic and idempotent (assignStations is a fixpoint on
  // its own output), same pattern as lastSlotsRef below.
  const stationsRef = useRef<ReadonlyMap<string, SpritePosition>>(new Map());
  const stations = assignStations(
    stationsRef.current,
    speakers.map((speaker) => speaker.id),
  );
  stationsRef.current = stations;

  const fresh = computeSpriteSlots(speakers, presence, stations);
  // GalGame sticky sprites: transitional narration turns often have no active
  // cast — keep the previous line-up on stage (dimmed) instead of blinking
  // everyone out, until a turn with a real cast replaces it.
  const lastSlotsRef = useRef(fresh);
  if (fresh.length > 0) lastSlotsRef.current = fresh;
  const sticky = fresh.length === 0 && lastSlotsRef.current.length > 0;
  const slots = sticky
    ? lastSlotsRef.current.map((slot) => ({ ...slot, active: false }))
    : fresh;
  const lanes = computeSpriteLanes(slots.map((slot) => slot.pos));

  return (
    <div
      className={clsx(
        "pointer-events-none absolute inset-x-0 top-0 bottom-[26%] transition-[filter,opacity] duration-300",
        dimmed && "opacity-60 brightness-[.72]",
      )}
      data-testid="stage-sprites"
    >
      {slots.map((slot, index) => (
        <div
          key={slot.characterId}
          // ponytail: transitions `left`/`width` (layout props, against the
          // web rules) — ≤4 absolutely-positioned sprites moving once per
          // enter/leave; FLIP/transform plumbing isn't worth it. The global
          // prefers-reduced-motion block collapses it. Lane changes only
          // happen on cast membership changes (assignStations), so this
          // reads as "stepping aside", never as drift. Active speaker sits
          // on top for the residual glow/shadow overlap at lane edges.
          className="ui-stage-sprite absolute bottom-0 h-[92%] px-1 transition-[left,width] duration-500 ease-out"
          style={{
            left: `${lanes[index].leftPct}%`,
            width: `${lanes[index].widthPct}%`,
            zIndex: slot.active ? 2 : 1,
          }}
        >
          <div
            className={clsx(
              "flex h-full w-full items-end justify-center transition-[filter,transform] duration-300 ease-out",
              slot.active
                ? "ui-stage-sprite-active"
                : "ui-stage-sprite-inactive",
            )}
          >
            {slot.ref ? (
              <Media
                src={slot.ref}
                sessionId={sessionId}
                alt={slot.displayName}
                fit="contain"
                rounded="none"
                maxHeight="100%"
              />
            ) : (
              // No sprite/avatar yet — a name-initial standee keeps the
              // speaker on stage so the dialog nameplate matches someone.
              <div
                className="ui-stage-sprite-fallback"
                aria-label={slot.displayName}
              >
                {slot.displayName.trim().slice(0, 1)}
              </div>
            )}
          </div>
          <span
            className={clsx(
              "ui-stage-panel absolute bottom-1 left-1/2 -translate-x-1/2 rounded-full px-3 py-0.5 text-xs whitespace-nowrap transition-colors duration-300",
              slot.active
                ? "border-[var(--accent-primary)] text-[var(--accent-primary)]"
                : "text-muted-foreground",
            )}
          >
            {slot.displayName}
          </span>
        </div>
      ))}
    </div>
  );
}
