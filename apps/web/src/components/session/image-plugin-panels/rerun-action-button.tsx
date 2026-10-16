import { useTranslation } from "react-i18next";
import type { CatalogAction } from "@covel/shared";
import { Button } from "@/components/ui/button.js";
import { invokeCatalogAction } from "@/lib/catalog/catalog-actions.js";
import { useI18nResolver } from "@/lib/catalog/helpers.js";
import { emitToast } from "@/lib/toast-channel.js";

export function RerunActionButton({
  action,
  sessionId,
  item,
  input,
  busy,
  setBusy,
}: {
  action: CatalogAction | undefined;
  sessionId: string | undefined;
  item: Record<string, unknown>;
  input: Record<string, unknown>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const resolve = useI18nResolver();
  if (!action) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy || !sessionId}
      onClick={() => {
        if (!sessionId) return;
        setBusy(true);
        void invokeCatalogAction({
          sessionId,
          action,
          scope: { item, props: input },
          t,
        })
          .catch((err) =>
            emitToast(
              "error",
              err instanceof Error ? err.message : t("common.error"),
            ),
          )
          .finally(() => setBusy(false));
      }}
    >
      {resolve(action.label) || t("catalog.jobList.rerun")}
    </Button>
  );
}
