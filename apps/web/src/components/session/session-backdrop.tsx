import type { StageBackdropModel } from "@covel/shared";
import { useUiSlots } from "@/stores/ui-slot-store.js";
import type { WorldRecord } from "@/services/api.js";
import type { ThemeSessionBackdrop } from "@/theme-system/layout.js";
import type { WorldVisual } from "@/lib/world-visuals.js";
import { StageBackdrop } from "./stage/StageBackdrop.js";

interface SessionBackdropProps {
  readonly mode: ThemeSessionBackdrop;
  readonly sessionId: string;
  readonly world: WorldRecord | null;
  readonly visual: WorldVisual;
}

/**
 * World art behind the text session, as the active theme's layout asks for it.
 * `scene` shows the same backdrop the stage view uses — the current scene from
 * the `stage.backdrop@1` slot, falling back to the world's cover — so the two
 * views agree on where the player is.
 */
export function SessionBackdrop({
  mode,
  sessionId,
  world,
  visual,
}: SessionBackdropProps) {
  // `banner` puts the art in the story itself (see `ChapterBanner`).
  if (mode === "none" || mode === "banner") return null;
  if (mode === "scene")
    return <SceneBackdrop sessionId={sessionId} world={world} />;
  return (
    <div className="ui-session-backdrop pointer-events-none absolute inset-0 overflow-hidden">
      <img
        src={visual.image}
        alt=""
        aria-hidden="true"
        width={1536}
        height={1024}
        loading="lazy"
        className="absolute inset-x-0 top-0 h-56 w-full object-cover opacity-[0.08] saturate-75"
        draggable={false}
      />
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-72"
        style={{
          background:
            "linear-gradient(180deg, color-mix(in oklab, var(--world-accent) 12%, transparent) 0%, var(--surface-page) 92%)",
        }}
      />
    </div>
  );
}

function SceneBackdrop({
  sessionId,
  world,
}: Pick<SessionBackdropProps, "sessionId" | "world">) {
  const scene = useUiSlots(sessionId).find(
    (entry) => entry.slot === "stage.backdrop@1",
  )?.value as StageBackdropModel | undefined;
  return (
    <div className="ui-session-backdrop ui-session-scene pointer-events-none absolute inset-0 overflow-hidden">
      <StageBackdrop sceneCurrent={scene} world={world} sessionId={sessionId} />
      {/* Darkens the side the story column sits on; themes tune the wash. */}
      <div aria-hidden="true" className="ui-session-scene-scrim" />
    </div>
  );
}
