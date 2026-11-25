import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TopbarStatusTone } from "@covel/shared/platform";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import {
  openPlatformTarget,
  usePlatformUiState,
} from "@/lib/platform-ui-events.js";
import { emitToast } from "@/lib/toast-channel.js";
import {
  fetchPluginInstanceData,
  invokePluginAppAction,
  type UISlotEntry,
  type UISlotSpec,
} from "@/services/api.js";
import { resolvePlatformIcon } from "./icon-lookup.js";

interface LiveBadgeStatus {
  readonly tone: TopbarStatusTone;
  readonly text: unknown;
}

const TONE_DOT_CLASS: Readonly<Record<TopbarStatusTone, string>> = {
  idle: "bg-muted-foreground/50",
  ok: "bg-emerald-500",
  syncing: "bg-sky-500 animate-pulse",
  warning: "bg-amber-500",
  error: "bg-destructive",
};

function isTone(value: unknown): value is TopbarStatusTone {
  return (
    value === "idle" ||
    value === "ok" ||
    value === "syncing" ||
    value === "warning" ||
    value === "error"
  );
}

function parseLiveBadgeStatus(
  raw: unknown,
  fallback: LiveBadgeStatus,
  includeLabel: boolean,
): LiveBadgeStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  return {
    tone: isTone(record.tone) ? record.tone : fallback.tone,
    text:
      record.text ?? (includeLabel ? record.label : undefined) ?? fallback.text,
  };
}

function TopbarStatusBadgeItem({
  pluginId,
  spec,
}: {
  readonly pluginId: string;
  readonly spec: UISlotSpec;
}) {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const { instanceDataVersion } = usePlatformUiState();

  const fallbackStatus: LiveBadgeStatus = {
    tone: spec.defaultStatus?.tone ?? "idle",
    text: spec.defaultStatus?.text ?? spec.label,
  };
  const [liveStatus, setLiveStatus] = useState<LiveBadgeStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshStatus = useCallback(
    async (signal?: AbortSignal) => {
      if (spec.dataSource?.namespace) {
        try {
          const res = await fetchPluginInstanceData(
            pluginId,
            spec.dataSource.namespace,
            signal,
          );
          if (signal?.aborted) return;
          const match = spec.dataSource.key
            ? res.entries.find((e) => e.key === spec.dataSource!.key)
            : res.entries[0];
          const parsed = parseLiveBadgeStatus(
            match?.value,
            fallbackStatus,
            true,
          );
          if (parsed) {
            setLiveStatus(parsed);
          } else if (match?.value !== undefined) {
            setLiveStatus({
              tone: fallbackStatus.tone,
              text: match.value,
            });
          }
          return;
        } catch {
          // Leave defaultStatus intact when read fails.
          if (signal?.aborted) return;
        }
      }
      if (spec.statusAction) {
        try {
          const res = await invokePluginAppAction<Record<string, unknown>>(
            pluginId,
            spec.statusAction,
            { trigger: "poll" },
          );
          if (signal?.aborted) return;
          const parsed = parseLiveBadgeStatus(res.result, fallbackStatus, true);
          if (parsed) {
            setLiveStatus(parsed);
          }
        } catch {
          // Transient poll failure leaves existing status untouched.
        }
      }
    },
    [
      pluginId,
      spec.dataSource?.namespace,
      spec.dataSource?.key,
      spec.statusAction,
      fallbackStatus.tone,
      fallbackStatus.text,
    ],
  );

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    const pollSec = spec.pollIntervalSec;

    const runOnce = async () => {
      if (cancelled) return;
      controller = new AbortController();
      try {
        await refreshStatus(controller.signal);
      } catch {
        // Transient poll failure leaves existing status untouched.
      } finally {
        controller = null;
        if (!cancelled && pollSec) {
          timer = window.setTimeout(() => {
            void runOnce();
          }, pollSec * 1000);
        }
      }
    };

    void runOnce();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [refreshStatus, instanceDataVersion, spec.pollIntervalSec]);

  const active = liveStatus ?? fallbackStatus;
  const Icon = resolvePlatformIcon(spec.icon);
  const labelText =
    resolveDisplayText(active.text, locale) ||
    resolveDisplayText(spec.label, locale) ||
    spec.id ||
    pluginId;

  const handleClick = async () => {
    if (!spec.statusAction || busy) return;
    setBusy(true);
    try {
      const res = await invokePluginAppAction<Record<string, unknown>>(
        pluginId,
        spec.statusAction,
        { trigger: "click" },
      );
      const result = res.result;
      if (result && typeof result === "object") {
        if (openPlatformTarget(pluginId, result)) return;
        if (result.tone !== undefined || result.text !== undefined) {
          const parsed = parseLiveBadgeStatus(result, active, false);
          if (parsed) setLiveStatus(parsed);
        }
      }
    } catch (err) {
      emitToast("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const dotClass = TONE_DOT_CLASS[active.tone] ?? TONE_DOT_CLASS.idle;
  const clickable = Boolean(spec.statusAction);

  return (
    <button
      type="button"
      disabled={!clickable || busy}
      onClick={() => void handleClick()}
      data-testid={`topbar-status-${pluginId}-${spec.id ?? "default"}`}
      title={resolveDisplayText(spec.label, locale) || labelText}
      className={`inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/70 px-2.5 py-1 text-xs text-foreground transition-colors ${
        clickable
          ? "hover:bg-muted/60 cursor-pointer"
          : "cursor-default opacity-85"
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`}
      />
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-75" />
      <span className="max-w-36 truncate">{labelText}</span>
    </button>
  );
}

export function TopbarStatusBadges({
  entries,
}: {
  readonly entries: readonly UISlotEntry[];
}) {
  if (entries.length === 0) return null;
  const items = entries.flatMap((entry) =>
    entry.specs
      .filter((spec) => spec.id && !spec.webview)
      .map((spec) => ({ pluginId: entry.pluginId, spec })),
  );
  if (items.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5" role="status">
      {items.map(({ pluginId, spec }) => (
        <TopbarStatusBadgeItem
          key={`${pluginId}:${spec.id}`}
          pluginId={pluginId}
          spec={spec}
        />
      ))}
    </div>
  );
}
