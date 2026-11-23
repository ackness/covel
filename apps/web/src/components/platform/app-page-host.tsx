import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import {
  closePluginAppPage,
  usePlatformUiState,
} from "@/lib/platform-ui-events.js";
import type { UISlotEntry } from "@/services/api.js";
import { InstancePluginPanel } from "./instance-panel-host.js";

export function AppPageHost({
  entries,
}: {
  readonly entries: readonly UISlotEntry[];
}) {
  const { activeAppPage } = usePlatformUiState();
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;

  if (!activeAppPage) return null;

  const entry = entries.find(
    (item) => item.pluginId === activeAppPage.pluginId,
  );
  const spec = entry?.specs.find((item) => item.id === activeAppPage.pageId);
  if (!spec) return null;

  const title =
    resolveDisplayText(spec.label, locale) || spec.id || activeAppPage.pluginId;
  const description =
    spec.description !== undefined
      ? resolveDisplayText(spec.description, locale)
      : "";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closePluginAppPage();
      }}
    >
      <DialogContent className="flex h-[min(86dvh,54rem)] max-w-4xl flex-col gap-3 overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <InstancePluginPanel
            pluginId={activeAppPage.pluginId}
            panelId={spec.id}
            spec={spec}
            fill
            expanded
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
