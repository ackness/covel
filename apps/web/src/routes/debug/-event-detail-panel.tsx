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
    <div className="absolute inset-0 z-20 flex w-full max-w-none shrink-0 flex-col border-l border-border ui-rail sm:static sm:w-96 sm:max-w-[55vw] lg:w-136 xl:w-2xl">
      <div className="px-3 py-2 border-b border-(--rule-color) flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {t("debugger.eventDetail")}
        </h3>
        <button
          onClick={onClose}
          className="text-xs text-muted-foreground hover:text-foreground"
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
