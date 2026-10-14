import { useTranslation } from "react-i18next";
import type { ThemeContrastResult } from "@/theme-system/contrast.js";

/** Advisory only: missing/complex colours are unknown, and a low ratio never blocks use. */
export function ContrastNotice({
  results,
}: {
  results: readonly ThemeContrastResult[];
}) {
  const { t, i18n } = useTranslation();
  const warnings = results.filter(
    (result) => result.ratio === null || result.ratio < result.minimum,
  );
  if (warnings.length === 0) return null;
  return (
    <div
      role="status"
      className="space-y-1 border border-(--accent-warning)/40 bg-(--accent-warning)/10 p-3 text-xs text-(--accent-warning)"
    >
      <p>{t("appearance.contrast.advisory")}</p>
      <ul>
        {warnings.map((result) => (
          <li key={`${result.scheme}:${result.pair}`}>
            {t(
              result.ratio === null
                ? "appearance.contrast.unknown"
                : "appearance.contrast.low",
              {
                scheme: t(`settings.themeScheme.${result.scheme}`),
                pair: t(`appearance.contrast.${result.pair}`),
                ratio: result.ratio?.toLocaleString(i18n.language, {
                  maximumFractionDigits: 2,
                }),
                minimum: result.minimum.toLocaleString(i18n.language),
              },
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
