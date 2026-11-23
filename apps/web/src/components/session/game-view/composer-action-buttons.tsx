import { useState } from "react";
import type { TFunction } from "i18next";
import { Terminal } from "lucide-react";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import { requestConfirm } from "@/lib/confirm-channel.js";
import { openPluginWindow } from "@/lib/platform-ui-events.js";
import { emitToast } from "@/lib/toast-channel.js";
import type { UISlotEntry, UISlotSpec } from "@/services/api.js";
import { postPluginRpcWithApproval } from "../plugin-rpc-ui.js";
import { resolvePlatformIcon } from "@/components/platform/icon-lookup.js";

export function ComposerActionButtons({
  sessionId,
  entries,
  disabled,
  locale,
  t,
}: {
  readonly sessionId: string;
  readonly entries: readonly UISlotEntry[];
  readonly disabled: boolean;
  readonly locale: string;
  readonly t: TFunction;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const items = entries.flatMap((entry) =>
    entry.specs
      .filter((spec) => spec.action || spec.command || spec.openWindow)
      .map((spec) => ({ pluginId: entry.pluginId, spec })),
  );
  if (items.length === 0) return null;

  const invoke = async (pluginId: string, spec: UISlotSpec, key: string) => {
    if (disabled || busyKey) return;
    if (spec.openWindow) {
      openPluginWindow(pluginId, spec.openWindow);
      return;
    }
    setBusyKey(key);
    try {
      const request = spec.action
        ? {
            kind: "action" as const,
            pluginId,
            action: spec.action,
            ...(spec.params ? { payload: spec.params } : {}),
          }
        : {
            kind: "command" as const,
            commandId: `${pluginId}:${spec.command}`,
            input: `/${spec.command}`,
          };
      const label =
        resolveDisplayText(spec.label, locale) ||
        spec.action ||
        spec.command ||
        pluginId;
      await postPluginRpcWithApproval({
        sessionId,
        request,
        pluginId,
        actionLabel: label,
        confirm: requestConfirm,
        t,
      });
    } catch (err) {
      emitToast("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1 px-1 pb-1">
      {items.map(({ pluginId, spec }, index) => {
        const key = `${pluginId}:${spec.id ?? index}`;
        const label =
          resolveDisplayText(spec.label, locale) ||
          spec.id ||
          spec.action ||
          spec.command ||
          pluginId;
        const tooltip =
          spec.tooltip !== undefined
            ? resolveDisplayText(spec.tooltip, locale)
            : label;
        const Icon = resolvePlatformIcon(spec.icon, Terminal);
        return (
          <button
            key={key}
            type="button"
            disabled={disabled || busyKey !== null}
            onClick={() => void invoke(pluginId, spec, key)}
            title={tooltip || label}
            aria-label={label}
            className="inline-flex h-7 items-center gap-1 rounded-(--radius-control) border border-border/60 bg-background/60 px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-40"
          >
            <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate max-w-28">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
