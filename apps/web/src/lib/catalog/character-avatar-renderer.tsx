import { useState } from "react";
import type { ComponentRenderer } from "@json-render/react";
import type { CharacterVisualModel } from "@covel/shared";
import { Media } from "@/components/Media.js";
import { MediaPreviewDialog } from "@/components/MediaPreviewDialog.js";
import { useUiSlot } from "@/stores/ui-slot-store.js";
import { useActiveSessionId } from "./session-context.js";

/** Avatar imagery comes from the kernel's character visual slot. */
export const CharacterAvatar: ComponentRenderer = ({ element }) => {
  const props = element.props ?? {};
  const characterId =
    typeof props.characterId === "string" ? props.characterId : undefined;
  const size = typeof props.size === "number" ? props.size : 28;

  const sessionId = useActiveSessionId();
  const [zoomed, setZoomed] = useState(false);
  const visual = useUiSlot(sessionId ?? "", "character.visual@1", characterId)
    ?.value as CharacterVisualModel | undefined;
  const avatar = visual?.avatar;

  if (!avatar) return null;
  return (
    <>
      <button
        type="button"
        // Stop the click from also toggling the surrounding (collapsible) card.
        onClick={(e) => {
          e.stopPropagation();
          setZoomed(true);
        }}
        className="inline-block shrink-0 overflow-hidden rounded-md border border-border cursor-zoom-in"
        style={{ width: size, height: size }}
        aria-label="enlarge portrait"
      >
        <Media
          src={avatar}
          sessionId={sessionId}
          alt=""
          aspectRatio="1/1"
          rounded="md"
          fit="cover"
        />
      </button>
      <MediaPreviewDialog
        mediaRef={zoomed ? avatar : null}
        sessionId={sessionId}
        aspectRatio="3/4"
        onClose={() => setZoomed(false)}
      />
    </>
  );
};
