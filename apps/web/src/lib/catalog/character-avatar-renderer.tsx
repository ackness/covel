import type { ComponentRenderer } from "@json-render/react";
import type { CharacterVisualModel } from "@covel/shared";
import { AvatarDisplay } from "./avatar-display.js";
import { useUiSlot } from "@/stores/ui-slot-store.js";
import { useActiveSessionId } from "./session-context.js";

/** Avatar imagery comes from the kernel's character visual slot. */
export const CharacterAvatar: ComponentRenderer = ({ element }) => {
  const props = element.props ?? {};
  const characterId =
    typeof props.characterId === "string" ? props.characterId : undefined;
  const size = typeof props.size === "number" ? props.size : 28;

  const sessionId = useActiveSessionId();
  const visual = useUiSlot(sessionId ?? "", "character.visual@1", characterId)
    ?.value as CharacterVisualModel | undefined;
  const avatar = visual?.avatar;

  if (!avatar) return null;
  return (
    <AvatarDisplay
      key={JSON.stringify([sessionId, characterId, avatar])}
      avatar={avatar}
      sessionId={sessionId}
      size={size}
    />
  );
};
