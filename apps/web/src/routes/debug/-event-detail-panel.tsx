import { useTranslation } from "react-i18next";
import type * as api from "@/services/api.js";
import { EventDetail } from "./-event-detail.js";

export function EventDetailPanel({
  event,
  relatedEvents = [],
  onClose,
}: {
  event: api.TraceEvent;
  relatedEvents?: readonly api.TraceEvent[];
  onClose: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="w-96 lg:w-136 xl:w-2xl max-w-[55vw] shrink-0 border-l border-border flex flex-col min-h-0 ui-rail">
      <div className="px-3 py-2 border-b border-(--rule-color) flex items-center justify-between">
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
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <EventDetail event={event} relatedEvents={relatedEvents} />
      </div>
    </div>
  );
}
