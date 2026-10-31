import { useContext } from "react";
import { useTranslation } from "react-i18next";
import type { ComponentRenderer } from "@json-render/react";
import {
  sessionMessagesPropsSchema,
  sessionComposerPropsSchema,
} from "@covel/shared";
import { PluginViewSessionContext } from "@/components/session/plugin-view-session-context.js";
import { useActiveSessionId } from "./session-context.js";

function useLiveView() {
  const context = useContext(PluginViewSessionContext);
  const sessionId = useActiveSessionId();
  return context?.sessionId === sessionId ? context : null;
}

function Unavailable() {
  const { t } = useTranslation();
  return (
    <p role="status" className="p-3 text-sm text-muted-foreground">
      {t("session.liveViewUnavailable")}
    </p>
  );
}

export const SessionMessages: ComponentRenderer = ({ element }) => {
  const host = useLiveView();
  const parsed = sessionMessagesPropsSchema.safeParse(element.props ?? {});
  if (!host || !parsed.success) return <Unavailable />;
  return (
    <PluginViewSessionContext.Provider value={null}>
      {host.renderMessages(parsed.data.content)}
    </PluginViewSessionContext.Provider>
  );
};

export const SessionComposer: ComponentRenderer = ({ element }) => {
  const host = useLiveView();
  if (
    !host ||
    !sessionComposerPropsSchema.safeParse(element.props ?? {}).success
  )
    return <Unavailable />;
  return (
    <PluginViewSessionContext.Provider value={null}>
      {host.renderComposer()}
    </PluginViewSessionContext.Provider>
  );
};
