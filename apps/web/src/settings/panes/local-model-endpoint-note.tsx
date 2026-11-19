import { AlertTriangle, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button.js";
import { copyText } from "@/components/ui/notice-parts.js";
import { SHARED_SERVER_DOCS_PAGE, docsPageUrl } from "@/lib/docs-links.js";
import { sharedServerEndpointNote } from "@/lib/local-network-url.js";
import {
  getSharedServerInfo,
  isModelRelaySupported,
} from "@/services/api/health.js";
import { SettingsHelp } from "../pane-layout.js";

export function LocalModelEndpointNote({
  baseUrl,
  provider,
}: {
  baseUrl: string;
  provider: string;
}) {
  const { t, i18n } = useTranslation();
  if (!getSharedServerInfo()) return null;
  const note = sharedServerEndpointNote(baseUrl, isModelRelaySupported());
  if (!note) return null;
  if (note !== "relay") {
    return (
      <div
        role="note"
        className="flex items-start gap-2 rounded-md border border-(--accent-warning)/30 bg-(--accent-warning)/5 p-3 text-xs leading-relaxed"
      >
        <AlertTriangle
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-(--accent-warning)"
        />
        {t(
          note === "lan-http"
            ? "sharedServer.localHttp"
            : "sharedServer.localEndpoint",
        )}
      </div>
    );
  }

  const origin = window.location.origin;
  const docs = docsPageUrl(SHARED_SERVER_DOCS_PAGE, i18n.language);
  const providerId = provider.trim().toLowerCase();
  const setup =
    providerId === "magpie"
      ? "magpie"
      : providerId === "ollama"
        ? "ollama"
        : providerId === "lmstudio"
          ? "lmstudio"
          : "generic";
  return (
    <SettingsHelp label={t("sharedServer.localRelayTitle")}>
      <div className="flex min-w-0 flex-col gap-2.5">
        {setup === "magpie" ? (
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-muted-foreground">
            <li>{t("sharedServer.localRelayMagpieSharing")}</li>
            <li>{t("sharedServer.localRelayMagpieKey")}</li>
            <li>{t("sharedServer.localRelayMagpieOrigin")}</li>
          </ol>
        ) : (
          <p className="wrap-break-word text-muted-foreground">
            {t(`sharedServer.localRelaySetup.${setup}`, { origin })}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-muted-foreground">
            {t("sharedServer.localRelaySiteOrigin")}
          </span>
          <code className="min-w-0 break-all text-foreground">{origin}</code>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="pointer-coarse:size-11"
            aria-label={t("sharedServer.localRelayCopyOrigin")}
            title={t("sharedServer.localRelayCopyOrigin")}
            onClick={() => void copyText(origin)}
          >
            <Copy />
          </Button>
        </div>
        <p className="text-muted-foreground">{t("sharedServer.localRelay")}</p>
        <a
          href={`${docs}#${setup === "magpie" ? "magpie" : "local-model-setup"}`}
          target="_blank"
          rel="noopener noreferrer"
          className="w-fit text-primary underline underline-offset-2"
        >
          {t("sharedServer.localRelayGuide")}
        </a>
      </div>
    </SettingsHelp>
  );
}
