import { useTranslation } from "react-i18next";
import type * as api from "@/services/api.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { EventDetail } from "./-event-detail.js";

export function EventDetailPanel({
  event,
  onClose,
}: {
  event: api.TraceEvent;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="w-80 flex-shrink-0 border-l border-border flex flex-col min-h-0 ui-rail">
      <div className="px-3 py-2 border-b border-[var(--rule-color)] flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {t("debugger.eventDetail")}
        </h3>
        <button
          onClick={onClose}
          className="text-[10px] text-muted-foreground hover:text-foreground"
        >
          {t("debugger.close")}
        </button>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <EventDetail event={event} />
      </ScrollArea>
    </div>
  );
}
