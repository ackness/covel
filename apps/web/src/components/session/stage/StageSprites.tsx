/**
 * Sprite layer for stage mode (spec §2 `StageSprites`). Stations
 * `computeSpriteSlots`' output across the stage, brightening the primary
 * speaker and dimming the rest. Entrance is a CSS keyframe (opacity +
 * translateY); the active/inactive filter and scale live on an *inner*
 * element so they never fight the entrance animation for control of
 * `transform` (see the `.ui-stage-rise-in` comment in index.css).
 */
import { clsx } from "clsx";
import type { ReactElement } from "react";
import { Media } from "@/components/Media.js";
import { type PresenceRecord, type StageSpeaker } from "./stage-selectors.js";
import {
  EXIT_ANIMATIONS,
  useStageSpriteTransitions,
} from "./use-stage-sprite-transitions.js";

export interface StageSpritesProps {
  readonly speakers: readonly StageSpeaker[];
  readonly presence: Readonly<Record<string, PresenceRecord | undefined>>;
  readonly sessionId: string;
  /** Choice overlay open — pull focus off the sprites (classic VN dim). */
  readonly dimmed?: boolean;
  /** The cast selection may briefly report no speakers between turns. An
   * authoritative stage-direction `actors: []` instead permits departure. */
  readonly retainWhenEmpty?: boolean;
}

export function StageSprites({
  speakers,
  presence,
  sessionId,
  dimmed = false,
  retainWhenEmpty = true,
}: StageSpritesProps): ReactElement {
  const { live, outgoing, finish } = useStageSpriteTransitions({
    speakers,
    presence,
    sessionId,
    retainWhenEmpty,
  });

  return (
    <div
      className={clsx(
        // Dim is brightness-only: opacity made sprites see-through against
        // the backdrop for the whole idle wait, which read as a rendering bug.
        "pointer-events-none absolute inset-x-0 top-0 bottom-[45%] md:bottom-[26%] transition-[filter] duration-300",
        dimmed && "brightness-[.78]",
      )}
      data-testid="stage-sprites"
    >
      {[...outgoing, ...live].map((entry) => {
        const { slot, lane } = entry;
        const generation =
          "generation" in entry && typeof entry.generation === "number"
            ? entry.generation
            : undefined;
        return (
          <div
            // Keep Media mounted across departure; generations guard cleanup.
            key={slot.characterId}
            data-character-id={slot.characterId}
            onAnimationEnd={(event) => {
              if (
                generation !== undefined &&
                event.target === event.currentTarget &&
                event.animationName ===
                  EXIT_ANIMATIONS[slot.transition ?? "fade"]
              )
                finish(generation);
            }}
            // ponytail: transitions `left`/`width` (layout props, against the
            // web rules) — ≤4 live sprites moving once per
            // enter/leave; FLIP/transform plumbing isn't worth it. The global
            // prefers-reduced-motion block collapses it. Lanes change on cast
            // membership changes (assignStations), never on speaker switches;
            // focus changes stay within each stable lane. Active speaker sits on
            // top for the residual glow/shadow overlap at lane edges.
            className="ui-stage-sprite absolute bottom-0 h-[92%] px-1 transition-[left,width] duration-500 ease-out"
            data-transition={slot.transition ?? "fade"}
            data-phase={slot.exiting ? "exit" : "present"}
            aria-hidden={slot.exiting || undefined}
            style={{
              left: `${lane.leftPct}%`,
              width: `${lane.widthPct}%`,
              zIndex: slot.exiting ? 0 : slot.active ? 2 : 1,
            }}
          >
            <div
              className={clsx(
                "flex h-full w-full items-end justify-center transition-[filter,transform] duration-300 ease-out",
                slot.active && !slot.exiting
                  ? "ui-stage-sprite-active"
                  : "ui-stage-sprite-inactive",
              )}
            >
              {slot.ref ? (
                <div
                  key={slot.variantId ?? slot.ref.id}
                  className="ui-stage-visual flex h-full w-full items-end justify-center"
                  style={{
                    animation: slot.exiting ? "none" : undefined,
                    transform: `translate(${slot.framing?.offsetX ?? 0}%, ${slot.framing?.offsetY ?? 0}%) scale(${slot.framing?.scale ?? 1})`,
                    transformOrigin: "bottom center",
                    maskImage:
                      "linear-gradient(to bottom, black 78%, transparent 100%)",
                  }}
                  data-visual-variant={slot.variantId}
                  data-transition={slot.transition ?? "fade"}
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
            {!slot.ref && (
              <span
                className={clsx(
                  "ui-stage-panel absolute bottom-1 left-1/2 -translate-x-1/2 rounded-full px-3 py-0.5 text-xs whitespace-nowrap transition-colors duration-300",
                  slot.active
                    ? "border-(--accent-primary) text-(--accent-primary)"
                    : "text-muted-foreground",
                )}
              >
                {slot.displayName}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
