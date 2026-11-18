import { getBuiltinProviderConnection } from "@covel/shared";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import {
  formatModelUses,
  type SessionModelUse,
} from "../provider-failure-notice.js";

/** A choice at start, never a requirement to configure a model before playing. */
export function MissingCredentialsDialog({
  open,
  onOpenChange,
  uses,
  onConfigure,
  onStart,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  uses: readonly SessionModelUse[];
  onConfigure: () => void;
  onStart: () => void;
}) {
  const { t, i18n } = useTranslation();
  const providers = new Map<string, string[]>();
  for (const use of uses) {
    const slotIds = providers.get(use.provider) ?? [];
    slotIds.push(use.slotId);
    providers.set(use.provider, slotIds);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] max-w-xl flex-col overflow-hidden p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>{t("session.missingCredentials.title")}</DialogTitle>
          <DialogDescription>
            {t("session.missingCredentials.detail")}
          </DialogDescription>
        </DialogHeader>
        <ul className="ui-scroll min-h-0 space-y-2 overflow-y-auto overscroll-contain text-sm">
          {[...providers].map(([provider, slots]) => (
            <li key={provider}>
              {t("session.missingCredentials.provider", {
                provider:
                  getBuiltinProviderConnection(provider)?.label ?? provider,
                slots: formatModelUses(t, i18n.language, slots),
              })}
            </li>
          ))}
        </ul>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:justify-end">
          <Button onClick={onConfigure}>
            {t("session.missingCredentials.configure")}
          </Button>
          <Button variant="outline" onClick={onStart}>
            {t("session.missingCredentials.startAnyway")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
