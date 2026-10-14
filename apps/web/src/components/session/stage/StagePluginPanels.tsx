import { useTranslation } from "react-i18next";
import type { RightPanelState } from "../right-panel-state.js";
import type { UISlotSpec } from "@/services/api/plugin-data.js";
import { PluginPanel } from "../plugin-panel.js";

interface Props {
  panelState: Pick<
    RightPanelState,
    "rightSpecs" | "specsStatus" | "retrySpecs"
  >;
  activePluginIds: readonly string[];
  turnId?: string;
  turnIds: readonly string[];
  choices: readonly { id: string; text: string }[];
  executing: boolean;
  onDraftMessage: (text: string) => void;
}

function Panel({
  pluginId,
  spec,
  ...props
}: Props & {
  pluginId: string;
  spec: UISlotSpec;
}) {
  return (
    <PluginPanel
      pluginId={pluginId}
      spec={spec as unknown as Record<string, unknown>}
      interactionLocked={props.executing}
      surfaceContext={{
        surface: "stage",
        turnId: props.turnId ?? null,
        turnIds: props.turnIds,
        choices: props.choices,
      }}
      handlers={{
        sendMessage: ({ text }) => {
          if (
            !props.executing &&
            typeof text === "string" &&
            text.trim() &&
            text.length <= 4000
          )
            props.onDraftMessage(text);
        },
      }}
    />
  );
}

/** Every stage contribution is declared by its plugin, independent of business capability IDs. */
export function StagePluginPanels(props: Props) {
  const { t } = useTranslation();
  const { rightSpecs, specsStatus, retrySpecs } = props.panelState;
  const panels = rightSpecs.flatMap(({ pluginId, specs }) =>
    props.activePluginIds.includes(pluginId)
      ? specs
          .filter((spec) => spec.surfaces?.includes("stage"))
          .map((spec) => ({ pluginId, spec }))
      : [],
  );
  if (!panels.length && specsStatus !== "error") return null;
  return (
    <div
      className="border-t border-border/50 px-3 py-2"
      data-testid="stage-plugin-panels"
    >
      {specsStatus === "error" && (
        <div role="alert" className="text-sm text-muted-foreground">
          <p>{t("session.panelLoadFailed")}</p>
          <button type="button" className="underline" onClick={retrySpecs}>
            {t("common.retry")}
          </button>
        </div>
      )}
      {panels.map(({ pluginId, spec }, index) => (
        <Panel
          key={`${pluginId}:${spec.id ?? index}`}
          {...props}
          pluginId={pluginId}
          spec={spec}
        />
      ))}
    </div>
  );
}
