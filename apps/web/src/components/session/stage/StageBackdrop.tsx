/**
 * Backdrop layer for stage mode (spec §2 `StageBackdrop`, §4 fallback
 * chain). Resolves scene art through `resolveBackdrop`'s four-tier
 * fallback and crossfades between frames: a static "previous" layer stays
 * put underneath while the new frame fades in on top, so a scene change
 * or a `pending` regeneration never flashes to black.
 */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import type { MediaRef } from "@covel/shared";
import { Media } from "@/components/Media.js";
import { isMediaRef } from "@/lib/media-ref-utils.js";
import { worldVisual } from "@/lib/world-visuals.js";
import type { WorldRecord } from "@/services/api.js";
import { resolveBackdrop, type StageCurrentRecord } from "./stage-selectors.js";

export interface StageBackdropProps {
  readonly sceneCurrent: StageCurrentRecord | null | undefined;
  readonly world: WorldRecord | null;
  readonly sessionId: string;
}

type ResolvedLayer =
  | { readonly kind: "media"; readonly key: string; readonly ref: MediaRef }
  | { readonly kind: "url"; readonly key: string; readonly url: string }
  | { readonly kind: "gradient"; readonly key: "gradient" };

function renderLayer(
  layer: ResolvedLayer,
  sessionId: string,
): ReactElement | null {
  if (layer.kind === "media") {
    return (
      <Media
        src={layer.ref}
        sessionId={sessionId}
        fit="cover"
        rounded="none"
        // Media's default cover path pins the <img> to a forced
        // `aspect-ratio` box (1/1 unless overridden) via inline style,
        // which would clip a full-bleed backdrop to a square. "auto" plus
        // explicit h-full/w-full lets object-cover fill the actual
        // (arbitrarily-shaped) stage area instead.
        aspectRatio="auto"
        className="h-full w-full"
      />
    );
  }
  if (layer.kind === "url") {
    return (
      <img
        src={layer.url}
        alt=""
        aria-hidden="true"
        className="h-full w-full object-cover"
      />
    );
  }
  return null;
}

export function StageBackdrop({
  sceneCurrent,
  world,
  sessionId,
}: StageBackdropProps): ReactElement {
  const visual = worldVisual(world);
  const backdrop = resolveBackdrop(sceneCurrent, visual);

  // `previous-or-hero` carries no ref of its own (spec §4: keep whatever
  // was last on screen while art regenerates) — remember the last frame
  // that actually resolved to scene art.
  const lastSceneRef = useRef<MediaRef | null>(null);
  if (backdrop.kind === "scene" && isMediaRef(backdrop.ref)) {
    lastSceneRef.current = backdrop.ref;
  }

  const layer: ResolvedLayer =
    backdrop.kind === "scene" && isMediaRef(backdrop.ref)
      ? { kind: "media", key: backdrop.ref.id, ref: backdrop.ref }
      : backdrop.kind === "previous-or-hero" && lastSceneRef.current
        ? {
            kind: "media",
            key: lastSceneRef.current.id,
            ref: lastSceneRef.current,
          }
        : backdrop.kind === "hero" || backdrop.kind === "previous-or-hero"
          ? {
              kind: "url",
              key:
                typeof backdrop.ref === "string" ? backdrop.ref : visual.image,
              url:
                typeof backdrop.ref === "string" ? backdrop.ref : visual.image,
            }
          : { kind: "gradient", key: "gradient" };

  // Two stacked layers drive the crossfade: `previous` is the last frame
  // shown (static, no animation) and `current` fades in on top via
  // `.ui-stage-crossfade` (remounted whenever `key` changes). A ref
  // mirrors `current` so the effect can compare against the latest value
  // without re-running on every render (see chat-messages.tsx's
  // confirmRequestRef for the same pattern).
  const [current, setCurrent] = useState<ResolvedLayer>(layer);
  const [previous, setPrevious] = useState<ResolvedLayer | null>(null);
  const currentRef = useRef(current);
  currentRef.current = current;
  useEffect(() => {
    if (layer.key === currentRef.current.key) return;
    setPrevious(currentRef.current);
    setCurrent(layer);
  }, [layer.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const gradientStyle: CSSProperties | undefined =
    current.kind === "gradient"
      ? {
          background: `radial-gradient(120% 120% at 50% 20%, color-mix(in oklab, ${visual.accent} 35%, transparent), var(--surface-page) 75%)`,
        }
      : undefined;

  return (
    <div
      className="absolute inset-0 overflow-hidden bg-black"
      data-testid="stage-backdrop"
    >
      {previous && (
        <div className="absolute inset-0">
          {renderLayer(previous, sessionId)}
        </div>
      )}
      <div
        key={current.key}
        className="ui-stage-crossfade absolute inset-0"
        style={gradientStyle}
      >
        {renderLayer(current, sessionId)}
      </div>
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/75 via-black/15 to-transparent"
        aria-hidden="true"
      />
    </div>
  );
}
