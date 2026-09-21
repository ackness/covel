import { useEffect, useState } from "react";
import { fetchUiSpecs, type UISlotSpec } from "@/services/api/plugin-data.js";
import { PluginPanel } from "../plugin-panel.js";

interface Props {
  sessionId: string;
  activePluginIds: readonly string[];
  turnId?: string;
  turnIds: readonly string[];
  choices: readonly { id: string; text: string }[];
  executing: boolean;
  onSendMessage: (text: string) => void;
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
            props.onSendMessage(text);
        },
      }}
    />
  );
}

/** Every stage contribution is declared by its plugin, independent of business capability IDs. */
export function StagePluginPanels(props: Props) {
  const key = `${props.sessionId}\n${[...props.activePluginIds].sort().join("\n")}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    panels: { pluginId: string; spec: UISlotSpec }[];
  }>();
  useEffect(() => {
    let cancelled = false;
    void fetchUiSpecs(props.sessionId)
      .then((response) => {
        if (!cancelled)
          setLoaded({
            key,
            panels: response.right.flatMap(({ pluginId, specs }) =>
              props.activePluginIds.includes(pluginId)
                ? specs
                    .filter((spec) => spec.surfaces?.includes("stage"))
                    .map((spec) => ({ pluginId, spec }))
                : [],
            ),
          });
      })
      .catch((error: unknown) =>
        console.warn("[stage] plugin UI discovery failed", error),
      );
    return () => {
      cancelled = true;
    };
  }, [key, props.sessionId]);
  const panels = loaded?.key === key ? loaded.panels : [];
  if (!panels.length) return null;
  return (
    <div
      className="border-t border-border/50 px-3 py-2"
      data-testid="stage-plugin-panels"
    >
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
