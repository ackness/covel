import { useTranslation } from "react-i18next";
import { Zap, Wand2 } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import type { UseRuntimeBindingsResult, RuntimeBindingEntry } from "@/hooks/use-runtime-bindings.js";

interface RuntimeBindingPanelProps {
  bindingState: UseRuntimeBindingsResult;
}

/**
 * Panel for assigning model slots to plugin runtimes.
 * Groups runtimes by plugin, shows tag badges, and provides
 * filtered dropdowns (only compatible-tag slots).
 */
export function RuntimeBindingPanel({ bindingState }: RuntimeBindingPanelProps) {
  const { t } = useTranslation();
  const { entries, allBound, setBinding, autoAssign, compatibleSlots } = bindingState;

  if (entries.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">
        {t("session.noRuntimes", "No runtimes to configure")}
      </p>
    );
  }

  // Group entries by plugin
  const grouped = new Map<string, { displayName: string; entries: RuntimeBindingEntry[] }>();
  for (const entry of entries) {
    const existing = grouped.get(entry.pluginId);
    if (existing) {
      existing.entries.push(entry);
    } else {
      grouped.set(entry.pluginId, {
        displayName: entry.pluginDisplayName ?? entry.pluginId,
        entries: [entry],
      });
    }
  }

  return (
    <div className="space-y-3">
      {/* Auto-assign button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {allBound ? (
            <Badge variant="secondary" className="text-[10px] bg-green-500/10 text-green-600">
              {t("session.allBound", "All bound")}
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-[10px] bg-amber-500/10 text-amber-600">
              {t("session.unboundRuntimes", "Unbound runtimes")}
            </Badge>
          )}
        </div>
        <Button variant="ghost" size="sm" className="text-xs" onClick={autoAssign}>
          <Wand2 className="w-3.5 h-3.5 mr-1" />
          {t("session.autoAssign", "Auto Assign")}
        </Button>
      </div>

      {/* Grouped runtime list */}
      {Array.from(grouped.entries()).map(([pluginId, group]) => (
        <div key={pluginId} className="border border-border">
          <div className="px-3 py-2 bg-muted/30 text-xs font-medium">
            {group.displayName}
          </div>
          <div className="divide-y divide-border">
            {group.entries.map((entry) => {
              const slots = compatibleSlots(entry.providerTag);
              return (
                <div key={entry.qualifiedId} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Zap className="w-3 h-3 text-muted-foreground shrink-0" />
                    <span className="text-xs font-mono truncate">
                      {entry.qualifiedId.split(":")[1]}
                    </span>
                    <Badge
                      variant="outline"
                      className={`text-[10px] shrink-0 ${
                        entry.providerTag === "image"
                          ? "border-purple-500/50 text-purple-600"
                          : "border-blue-500/50 text-blue-600"
                      }`}
                    >
                      {entry.providerTag}
                    </Badge>
                  </div>
                  <div className="shrink-0">
                    {slots.length === 0 ? (
                      <span className="text-[10px] text-muted-foreground italic">
                        {t("session.noCompatibleSlot", "No compatible slot")}
                      </span>
                    ) : (
                      <select
                        value={entry.slotName}
                        onChange={(e) => setBinding(entry.qualifiedId, e.target.value)}
                        className="bg-background border border-border px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary min-w-[120px]"
                      >
                        <option value="">
                          {t("session.selectSlot", "-- Select --")}
                        </option>
                        {slots.map((slot) => (
                          <option key={slot.slotId} value={slot.slotId}>
                            {slot.slotId}
                            {slot.serverModel ? ` (${slot.serverModel})` : ""}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
