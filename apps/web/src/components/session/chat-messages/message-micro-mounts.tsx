import { useState } from "react";
import type { TFunction } from "i18next";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import { requestConfirm } from "@/lib/confirm-channel.js";
import { emitToast } from "@/lib/toast-channel.js";
import type { UISlotEntry, UISlotSpec } from "@/services/api.js";
import type { StreamMessage } from "@/stores/session-store.js";
import { PluginPanel } from "../plugin-panel.js";
import { postPluginRpcWithApproval } from "../plugin-rpc-ui.js";
import { resolvePlatformIcon } from "@/components/platform/icon-lookup.js";

function matchesMessageFilter(msg: StreamMessage, spec: UISlotSpec): boolean {
  if (spec.roles && !spec.roles.includes(msg.role as "user" | "assistant")) {
    return false;
  }
  if (spec.kinds && (!msg.kind || !spec.kinds.includes(msg.kind))) {
    return false;
  }
  return true;
}

export function MessageActionButtons({
  msg,
  sessionId,
  entries,
  executing,
  locale,
  t,
}: {
  readonly msg: StreamMessage;
  readonly sessionId: string | undefined;
  readonly entries: readonly UISlotEntry[];
  readonly executing: boolean;
  readonly locale: string;
  readonly t: TFunction;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  if (!sessionId || entries.length === 0) return null;

  const items = entries.flatMap((entry) =>
    entry.specs
      .filter((spec) => spec.action && matchesMessageFilter(msg, spec))
      .map((spec) => ({ pluginId: entry.pluginId, spec })),
  );
  if (items.length === 0) return null;

  const invoke = async (pluginId: string, spec: UISlotSpec, key: string) => {
    if (!spec.action || executing || busyKey) return;
    setBusyKey(key);
    try {
      const label = resolveDisplayText(spec.label, locale) || spec.action;
      await postPluginRpcWithApproval({
        sessionId,
        request: {
          kind: "action",
          pluginId,
          action: spec.action,
          payload: {
            ...spec.params,
            messageId: msg.id,
            turnId: msg.turnId,
            role: msg.role,
            kind: msg.kind,
            content: msg.content,
          },
        },
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
    <div className="flex flex-wrap items-center gap-1">
      {items.map(({ pluginId, spec }, index) => {
        const key = `${pluginId}:${spec.id ?? index}`;
        const label =
          resolveDisplayText(spec.label, locale) || spec.id || spec.action!;
        const tooltip =
          spec.tooltip !== undefined
            ? resolveDisplayText(spec.tooltip, locale)
            : label;
        const Icon = resolvePlatformIcon(spec.icon, Sparkles);
        return (
          <Button
            key={key}
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[10px] text-muted-foreground hover:text-foreground gap-1 ui-eyebrow"
            disabled={executing || busyKey !== null}
            onClick={() => void invoke(pluginId, spec, key)}
            title={tooltip || label}
          >
            <Icon className="h-3 w-3" />
            <span>{label}</span>
          </Button>
        );
      })}
    </div>
  );
}

export function MessageBelowMounts({
  msg,
  entries,
}: {
  readonly msg: StreamMessage;
  readonly entries: readonly UISlotEntry[];
}) {
  if (entries.length === 0) return null;

  const items = entries.flatMap((entry) =>
    entry.specs
      .filter(
        (spec) => !spec.webview && spec.view && matchesMessageFilter(msg, spec),
      )
      .map((spec) => ({ pluginId: entry.pluginId, spec })),
  );
  if (items.length === 0) return null;

  return (
    <div className="flex w-full flex-col gap-1.5">
      {items.map(({ pluginId, spec }, index) => (
        <div
          key={`${pluginId}:${spec.id ?? index}`}
          style={
            spec.maxHeight !== undefined
              ? { maxHeight: `${spec.maxHeight}px`, overflowY: "auto" }
              : undefined
          }
          className="rounded-md border border-border/60 bg-background/50 p-2"
        >
          <PluginPanel
            pluginId={pluginId}
            panelId={spec.id}
            spec={spec as unknown as Record<string, unknown>}
            surfaceContext={{
              surface: "messageBelow",
              messageId: msg.id,
              role: msg.role,
              kind: msg.kind,
              turnId: msg.turnId,
            }}
            {...(spec.dataSource
              ? {}
              : {
                  stateOverride: {
                    messageId: msg.id,
                    role: msg.role,
                    kind: msg.kind,
                    turnId: msg.turnId,
                    content: msg.content,
                  },
                })}
          />
        </div>
      ))}
    </div>
  );
}
