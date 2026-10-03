import type { WorldRecord } from "@/services/api.js";
import { text } from "@/components/world/editor-helpers.js";
import { worldVisual } from "@/lib/world-visuals.js";

/**
 * `backdrop: "banner"` — the world's art as a chapter opening above the first
 * message. It sits in the story flow, so it scrolls away with the history
 * rather than taking a fixed strip of the reading area.
 */
export function ChapterBanner({
  world,
}: {
  readonly world: WorldRecord | null;
}) {
  const name = text(world?.name);
  const tags = (world?.tags ?? []).slice(0, 3).join(" · ");
  return (
    <header className="ui-chapter-banner relative overflow-hidden">
      <img
        src={worldVisual(world).image}
        alt=""
        aria-hidden="true"
        width={1536}
        height={1024}
        className="h-36 w-full object-cover md:h-44"
        draggable={false}
      />
      <div aria-hidden="true" className="ui-chapter-banner-scrim" />
      {/* White on the scrim in either colour scheme, like the world covers. */}
      <div className="absolute inset-x-5 bottom-4 text-white">
        {tags && <p className="ui-eyebrow text-white/80">{tags}</p>}
        {name && (
          <p className="ui-title mt-1 text-2xl leading-tight md:text-3xl">
            {name}
          </p>
        )}
      </div>
    </header>
  );
}
