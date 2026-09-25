import { useTranslation } from "react-i18next";

export function GithubPackageRiskConsent({
  kind = "plugin",
  hasServerCode,
  accepted,
  disabled,
  onChange,
}: {
  kind?: "plugin" | "world";
  hasServerCode: boolean;
  accepted: boolean;
  disabled: boolean;
  onChange: (accepted: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 rounded border border-amber-500/40 bg-amber-500/10 p-3">
      <p className="font-semibold">{t("settings.github.riskTitle")}</p>
      <p>
        {t(
          kind === "world"
            ? "settings.worldGithub.risk"
            : hasServerCode
              ? "settings.github.codeRisk"
              : "settings.github.contentRisk",
        )}
      </p>
      <p>
        {t(
          kind === "world"
            ? "settings.worldGithub.updateRisk"
            : "settings.github.targetRisk",
        )}
      </p>
      <p>{t("settings.github.indexRisk")}</p>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={accepted}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        {t("settings.github.accept")}
      </label>
    </div>
  );
}
