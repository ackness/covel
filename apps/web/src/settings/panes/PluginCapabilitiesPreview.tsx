import { useTranslation } from "react-i18next";
import type { GithubPluginPreview } from "@covel/shared";

export function PluginCapabilitiesPreview({
  preview,
  update = false,
}: {
  preview: Pick<GithubPluginPreview, "capabilities" | "trustedSource">;
  update?: boolean;
}) {
  const { t } = useTranslation();
  const capabilities = preview.capabilities;
  const rows = {
    serverCode: t(
      capabilities.serverCode
        ? "settings.capabilities.yes"
        : "settings.capabilities.no",
    ),
    http: capabilities.http
      .map((item) => `${item.origin} (${item.methods.join(", ")})`)
      .join("; "),
    hooks: capabilities.hooks
      .map((hook) => `${hook.event} (${hook.enforce})`)
      .join(", "),
    tools: capabilities.tools.join(", "),
    services: capabilities.services.join(", "),
    actions: capabilities.actions.join(", "),
    wires: capabilities.wires.join(", "),
    forms: capabilities.forms.join(", "),
    extensions: capabilities.extensions.join(", "),
    datasets: capabilities.datasets
      .map((dataset) => `${dataset.namespace} (${dataset.ops.join(", ")})`)
      .join("; "),
  };
  return (
    <span className="block space-y-1 text-xs">
      {preview.trustedSource && (
        <span className="block font-semibold text-primary">
          {t("settings.trustedSources.badge")}
        </span>
      )}
      <span className="block font-semibold">
        {t("settings.capabilities.title")}
      </span>
      {Object.entries(rows).map(([key, value]) => (
        <span key={key} className="block wrap-break-word">
          {t(`settings.capabilities.${key}`)}:{" "}
          {value || t("settings.capabilities.none")}
        </span>
      ))}
      {update && (
        <span className="block text-muted-foreground">
          {t("settings.trustedSources.growth")}
        </span>
      )}
    </span>
  );
}
