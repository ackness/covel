import { createContext, useContext } from "react";
import type { ComponentRenderer } from "@json-render/react";
import type { SegmentTemplateState } from "../segment-templates.js";
import { AvatarDisplay } from "./avatar-display.js";

/** Host-owned render scope, never added to a template's bindable state. */
export const SegmentTemplateContext = createContext<
  | {
      readonly sessionId: string;
      readonly character?: SegmentTemplateState["character"];
      readonly visual?: SegmentTemplateState["visual"];
    }
  | undefined
>(undefined);

/** No session/store reader: the resolved speaker is the only portrait source. */
export const SegmentCharacterAvatar: ComponentRenderer = ({ element }) => {
  const scope = useContext(SegmentTemplateContext);
  const props = element.props ?? {};
  const avatar = scope?.visual?.avatar;
  if (
    !scope?.sessionId ||
    !scope.character ||
    props.characterId !== scope.character.id ||
    scope.visual?.characterId !== scope.character.id ||
    !avatar
  )
    return null;
  return (
    <AvatarDisplay
      key={JSON.stringify([scope.sessionId, scope.character.id, avatar])}
      avatar={avatar}
      sessionId={scope.sessionId}
      size={typeof props.size === "number" ? props.size : undefined}
    />
  );
};
