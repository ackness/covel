import { useTranslation } from "react-i18next";
import type { GithubPluginPreview } from "@covel/shared";

interface CapabilityRow {
  readonly key: string;
  readonly value: string;
}

export function PluginCapabilitiesPreview({
  preview,
  update = false,
}: {
  preview: Pick<GithubPluginPreview, "capabilities" | "trustedSource">;
  update?: boolean;
}) {
  const { t } = useTranslation();
  const capabilities = preview.capabilities;
  const yes = t("settings.capabilities.yes");
  const no = t("settings.capabilities.no");

  const rows: CapabilityRow[] = [
    { key: "serverCode", value: capabilities.serverCode ? yes : no },
  ];

  const pushIf = (key: string, value: string | undefined) => {
    if (value) rows.push({ key, value });
  };

  if (capabilities.instanceScope) pushIf("instanceScope", yes);
  if (capabilities.providerSources?.length) {
    pushIf("providerSources", capabilities.providerSources.join(", "));
  }
  if (capabilities.flows?.length) {
    pushIf("flows", capabilities.flows.join(", "));
  }
  if (capabilities.appActions?.length) {
    pushIf("appActions", capabilities.appActions.join(", "));
  }
  if (capabilities.secrets) pushIf("secrets", yes);
  if (capabilities.authProxy) pushIf("authProxy", yes);
  if (capabilities.loopbackCallback) {
    const rawPorts = capabilities.loopbackCallback.ports;
    const ports = Array.isArray(rawPorts)
      ? rawPorts.length > 0
        ? ` (${rawPorts.join(", ")})`
        : ""
      : rawPorts
        ? ` (${rawPorts})`
        : "";
    pushIf("loopbackCallback", `${capabilities.loopbackCallback.path}${ports}`);
  }
  if (capabilities.scheduler) pushIf("scheduler", yes);
  if (capabilities.sandboxWorker) pushIf("sandboxWorker", yes);
  if (capabilities.appEvents?.length) {
    pushIf("appEvents", capabilities.appEvents.join(", "));
  }
  if (capabilities.http.length > 0) {
    pushIf(
      "http",
      capabilities.http
        .map((item) => `${item.origin} (${item.methods.join(", ")})`)
        .join("; "),
    );
  }
  if (capabilities.hooks.length > 0) {
    pushIf(
      "hooks",
      capabilities.hooks
        .map((hook) => `${hook.event} (${hook.enforce})`)
        .join(", "),
    );
  }
  if (capabilities.tools.length > 0) {
    pushIf("tools", capabilities.tools.join(", "));
  }
  if (capabilities.services.length > 0) {
    pushIf("services", capabilities.services.join(", "));
  }
  if (capabilities.actions.length > 0) {
    pushIf("actions", capabilities.actions.join(", "));
  }
  if (capabilities.wires.length > 0) {
    pushIf("wires", capabilities.wires.join(", "));
  }
  if (capabilities.forms.length > 0) {
    pushIf("forms", capabilities.forms.join(", "));
  }
  if (capabilities.extensions.length > 0) {
    pushIf("extensions", capabilities.extensions.join(", "));
  }
  if (capabilities.datasets.length > 0) {
    pushIf(
      "datasets",
      capabilities.datasets
        .map((dataset) => `${dataset.namespace} (${dataset.ops.join(", ")})`)
        .join("; "),
    );
  }

  return (
    <span className="block space-y-1.5 text-xs">
      {preview.trustedSource && (
        <span className="block font-semibold text-primary">
          {t("settings.trustedSources.badge")}
        </span>
      )}
      <span className="block font-semibold text-foreground">
        {t("settings.capabilities.title")}
      </span>
      <span className="grid gap-1 sm:grid-cols-2">
        {rows.map(({ key, value }) => (
          <span
            key={key}
            className="block rounded bg-muted/40 px-2 py-1 wrap-break-word text-foreground"
          >
            {t(`settings.capabilities.${key}`)}: {value}
          </span>
        ))}
      </span>
      {rows.length === 1 && (
        <span className="block text-muted-foreground">
          {t(
            "settings.capabilities.noExtra",
            "No additional host capabilities declared.",
          )}
        </span>
      )}
      {update && (
        <span className="block text-muted-foreground">
          {t("settings.trustedSources.growth")}
        </span>
      )}
    </span>
  );
}
