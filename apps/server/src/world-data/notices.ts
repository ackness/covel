import type {
  UnmetWorldRequirement,
  WorldDataImportNotice,
} from "@covel/shared";
import type { WorldDataRequirements } from "./requirements.js";
import type { WorldDataDiagnostic } from "./types.js";

function unique(
  notices: readonly WorldDataImportNotice[],
): WorldDataImportNotice[] {
  return notices.filter(
    (notice, index) =>
      notices.findIndex(
        (other) =>
          other.code === notice.code &&
          other.level === notice.level &&
          other.message === notice.message,
      ) === index,
  );
}

/** Public notices contain no author paths, record keys, source IDs or error text. */
export function worldDataImportNotices(
  diagnostics: readonly WorldDataDiagnostic[],
): WorldDataImportNotice[] {
  return unique(
    diagnostics.flatMap((diagnostic): WorldDataImportNotice[] =>
      diagnostic.level === "info" || diagnostic.localeOverlay
        ? []
        : [
            {
              level: diagnostic.level,
              ...(diagnostic.code ? { code: diagnostic.code } : {}),
              message:
                diagnostic.code === "dimension-provider-missing"
                  ? "World dimensions require a plugin implementing world.dimensions@1."
                  : diagnostic.code === "receiver-missing"
                    ? "This data has no plugin to receive it."
                    : "Some world data could not be imported. Ask the world author to check the package.",
            },
          ],
    ),
  );
}

/** Inventory, selection and import share one bounded player projection. */
export function worldDataRequirementNotices(
  inventory: WorldDataRequirements,
  unmet: readonly UnmetWorldRequirement[],
  diagnostics: readonly WorldDataDiagnostic[] = [],
): WorldDataImportNotice[] {
  const notices = [
    ...new Map(
      inventory.sources.map((source) => [source.sourceId, source]),
    ).values(),
  ].flatMap((source): WorldDataImportNotice[] => {
    const missing = unmet.filter((item) =>
      source.contracts.includes(item.contract),
    );
    if (
      !missing.length &&
      !diagnostics.some(
        (item) =>
          item.code === "receiver-missing" && item.sourceId === source.sourceId,
      )
    )
      return [];
    const code = missing.some((item) => item.code === "approval-required")
      ? "receiver-approval-required"
      : missing.some((item) => item.code === "ambiguous-provider")
        ? "receiver-ambiguous"
        : missing.length > 0 &&
            missing.every((item) => item.code === "excluded")
          ? "receiver-excluded"
          : "receiver-missing";
    return [
      {
        level: "warning",
        code,
        ...(!source.hidden && source.publicLabel
          ? { publicLabel: source.publicLabel }
          : {}),
        message: `This data has no plugin to receive it. ${code === "receiver-approval-required" ? "A receiver needs approval." : code === "receiver-ambiguous" ? "Choose a receiving plugin." : code === "receiver-excluded" ? "Receiving plugins are disabled." : "No receiving plugin is available."}`,
      },
    ];
  });
  return [
    ...notices,
    ...worldDataImportNotices(
      [...inventory.diagnostics, ...diagnostics].filter(
        (item) =>
          item.code !== "receiver-missing" ||
          !inventory.sources.some(
            (source) => source.sourceId === item.sourceId,
          ),
      ),
    ),
  ];
}
