import { useTranslation } from "react-i18next";
import type { GithubPluginPreview } from "@covel/shared";

type Capabilities = GithubPluginPreview["capabilities"];

function declaredCapabilityKeys(capabilities: Capabilities) {
  // Preserve the order of the disclosure, independent of manifest key order.
  return (
    [
      "instanceScope",
      "providerSources",
      "flows",
      "appActions",
      "secrets",
      "authProxy",
      "loopbackCallback",
      "scheduler",
      "sandboxWorker",
      "appEvents",
      "http",
      "hooks",
      "tools",
      "services",
      "actions",
      "wires",
      "forms",
      "extensions",
      "datasets",
    ] as const
  ).filter((key) => {
    const value = capabilities[key];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  });
}

export function countDeclaredCapabilities(capabilities: Capabilities): number {
  return (
    Number(capabilities.serverCode) +
    declaredCapabilityKeys(capabilities).length
  );
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

  const keys = declaredCapabilityKeys(capabilities);
  function textFor(key: (typeof keys)[number]) {
    switch (key) {
      case "loopbackCallback": {
        const callback = capabilities.loopbackCallback;
        if (!callback) return "";
        const ports = Array.isArray(callback.ports)
          ? callback.ports.join(", ")
          : callback.ports;
        return ports ? `${callback.path} (${ports})` : callback.path;
      }
      case "http":
        return capabilities.http
          .map((item) => `${item.origin} (${item.methods.join(", ")})`)
          .join("; ");
      case "hooks":
        return capabilities.hooks
          .map((hook) => `${hook.event} (${hook.enforce})`)
          .join(", ");
      case "datasets":
        return capabilities.datasets
          .map((item) => `${item.namespace} (${item.ops.join(", ")})`)
          .join("; ");
      default: {
        const value = capabilities[key];
        return Array.isArray(value) ? value.join(", ") : yes;
      }
    }
  }
  const rows = [
    { key: "serverCode", value: capabilities.serverCode ? yes : no },
    ...keys.map((key) => ({ key, value: textFor(key) })),
  ];

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
