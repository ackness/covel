import { useTranslation } from "react-i18next";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import type { UISlotSpec } from "@/services/api.js";
import { SettingsPaneHeader } from "@/settings/pane-layout.js";
import { InstancePluginPanel } from "./instance-panel-host.js";

export interface PluginSettingsSectionTarget {
  readonly pluginId: string;
  readonly spec: UISlotSpec;
}

export function PluginSettingsSectionPane({
  section,
}: {
  readonly section: PluginSettingsSectionTarget;
}) {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const title =
    resolveDisplayText(section.spec.label, locale) ||
    section.spec.id ||
    section.pluginId;
  const description =
    section.spec.description !== undefined
      ? resolveDisplayText(section.spec.description, locale)
      : undefined;

  return (
    <>
      <SettingsPaneHeader
        title={title}
        {...(description ? { description } : {})}
      />
      <InstancePluginPanel
        pluginId={section.pluginId}
        panelId={section.spec.id}
        spec={section.spec}
        forbidWebview
      />
    </>
  );
}
