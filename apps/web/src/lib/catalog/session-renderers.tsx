import type { ComponentRenderer } from "@json-render/react";
import { SessionDimensionsPanel } from "@/components/session/session-dimensions-panel.js";
import {
  AssetRender as AssetRenderComponent,
  AssetTurnSidebar as AssetTurnSidebarComponent,
} from "@/components/asset-render/index.js";
import type { AssetGenerateView } from "@covel/shared";
import { useI18nResolver } from "./helpers.js";
import { useActiveSessionId } from "./session-context.js";

/** Generic, versioned session values. World-package initial values are not a read fallback. */
export const WorldDimensions: ComponentRenderer = () => (
  <SessionDimensionsPanel />
);

/**
 * `AssetRender` registry entry — surfaces a single `AssetGenerateView`
 * (SPEC §5.7) inside a json-render spec. Plugin specs can opt-in via:
 *   `{ "type": "AssetRender", "props": { "view": {...}, "sessionId": "..." } }`
 *
 * The component routes by `view.modality` to the modality-specific renderer
 * (image / audio / generic-link). A passed-in `sessionId` overrides the
 * active-session lookup so debug fixtures still resolve media tokens.
 */
export const AssetRenderCatalog: ComponentRenderer = ({ element }) => {
  const sessionId = useActiveSessionId();
  const props = element.props ?? {};
  const view = props.view as AssetGenerateView | undefined;
  if (!view || typeof view !== "object" || view.type !== "asset.generate") {
    return null;
  }
  const overrideSession =
    typeof props.sessionId === "string" &&
    (props.sessionId as string).length > 0
      ? (props.sessionId as string)
      : sessionId;
  return <AssetRenderComponent view={view} sessionId={overrideSession} />;
};

/**
 * `AssetTurnSidebar` registry entry — fans out every asset recorded for
 * a turn from the session store. Plugin specs can opt-in via:
 *   `{ "type": "AssetTurnSidebar", "props": { "turnId": "{{turn.id}}" } }`
 *
 * Reads from `state.assetsByTurn` populated by the `asset.generated` SSE
 * handler. Renders nothing for turns with no assets, so it is safe to
 * mount unconditionally.
 */
export const AssetTurnSidebarCatalog: ComponentRenderer = ({ element }) => {
  const props = element.props ?? {};
  const turnId =
    typeof props.turnId === "string" ? (props.turnId as string) : "";
  if (!turnId) return null;
  const sessionId =
    typeof props.sessionId === "string" &&
    (props.sessionId as string).length > 0
      ? (props.sessionId as string)
      : undefined;
  return <AssetTurnSidebarComponent turnId={turnId} sessionId={sessionId} />;
};

// ── Form Components ──────────────────────────────────────────────

export const Form: ComponentRenderer = ({ children }) => {
  return (
    <div className="ui-frame overflow-hidden">
      <div className="p-5 space-y-4">{children}</div>
    </div>
  );
};

/** FormHeader — form title bar. */
export const FormHeader: ComponentRenderer = ({ element }) => {
  const resolve = useI18nResolver();
  const title = resolve(element.props?.title);
  return (
    <div className="ui-rule bg-muted/60 px-5 py-3 -mx-5 -mt-5 mb-3 border-b border-border">
      <span className="ui-entry-title text-[15px] font-medium text-foreground">
        {title}
      </span>
    </div>
  );
};
