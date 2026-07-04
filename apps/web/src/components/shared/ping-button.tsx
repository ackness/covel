import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Loader2, XCircle, Zap } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { pingPreset, type PingResult } from "@/services/api.js";

/**
 * Ping target — either a specific preset or a named slot.
 *
 * Slots resolve server-side through: client override → slotRegistry → tag
 * fallback → any enabled preset. The response's `testedTarget.resolvedVia`
 * lets the UI warn when a slot silently fell through.
 */
export type PingTarget =
  | { kind: "preset"; presetId: string }
  | { kind: "slot"; slotId: string };

export type PingVariant = "inline" | "icon";

interface PingButtonProps {
  target: PingTarget;
  /** "icon" = single Zap button (compact); "inline" = button + "Ping" label. */
  variant?: PingVariant;
  /** Tailwind size for the underlying Button. Defaults to "sm". */
  size?: "xs" | "sm";
  /** Result TTL in ms. Repeat clicks within TTL reuse the cached result. Default 60_000. */
  cacheTtlMs?: number;
  /** Hide latency display (e.g. when parent renders its own). Default false. */
  hideResult?: boolean;
  /** Called whenever a new (non-cached) ping completes. */
  onResult?: (result: PingResult) => void;
  /**
   * Runs before the HTTP request. Return false (or throw) to abort.
   *
   * Onboarding uses this to persist API keys + slot bindings before
   * probing `slot-<name>` — without it the server would resolve against
   * stale slot state. Returning a rejected promise surfaces the error
   * as a normal ping failure.
   */
  onBeforePing?: () => Promise<boolean | void> | boolean | void;
  className?: string;
}

// Module-level cache keyed by the server request id (preset id or `slot-<name>`).
// A successful probe is often reused across multiple UI surfaces (active
// model row + settings pane), so caching at this level avoids hitting the
// provider once per component.
const resultCache = new Map<string, { result: PingResult; at: number }>();

function requestIdFor(target: PingTarget): string {
  return target.kind === "preset" ? target.presetId : `slot-${target.slotId}`;
}

/**
 * Bucket raw provider/network error strings into a short actionable label
 * (`auth` / `rate-limited` / `timeout` / …) so the UI can surface what
 * the user can actually do about it. Pattern-based, never throws.
 */
function classifyPingError(raw: string | undefined): {
  kind: string;
  detail: string;
} {
  if (!raw) return { kind: "unknown", detail: "Unknown error" };
  const lower = raw.toLowerCase();
  if (/\b401\b|unauthoriz|invalid.+key|invalid.*api.?key/.test(lower)) {
    return { kind: "auth", detail: raw };
  }
  if (/\b403\b|forbidden/.test(lower))
    return { kind: "forbidden", detail: raw };
  if (/\b404\b|not found/.test(lower))
    return { kind: "not-found", detail: raw };
  if (/\b429\b|rate[-\s]?limit|too many/.test(lower))
    return { kind: "rate-limited", detail: raw };
  if (/\b5\d\d\b|server error|bad gateway|unavailable/.test(lower))
    return { kind: "server", detail: raw };
  if (/timeout|timed out|etimedout/.test(lower))
    return { kind: "timeout", detail: raw };
  if (
    /network|fetch|econnrefused|enotfound|socket|dns|offline|cors/.test(lower)
  )
    return { kind: "network", detail: raw };
  return { kind: "error", detail: raw };
}

/**
 * Shared Ping button — calls `/api/ai/ping` with a `presetId` or `slot-<name>`,
 * displays latency or error inline, and caches results for `cacheTtlMs`.
 *
 * Used by: settings key pane, settings slot pane (display-only), onboarding
 * wizard, active-model list (both card and compact variants).
 */
export function PingButton({
  target,
  variant = "inline",
  size = "sm",
  cacheTtlMs = 60_000,
  hideResult = false,
  onResult,
  onBeforePing,
  className,
}: PingButtonProps) {
  const { t } = useTranslation();
  const requestId = requestIdFor(target);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<PingResult | null>(null);

  // Hydrate from cache when the target changes (component reused for a
  // different preset/slot, or remounted within the TTL window).
  useEffect(() => {
    const cached = resultCache.get(requestId);
    if (cached && Date.now() - cached.at < cacheTtlMs) {
      setResult(cached.result);
    } else {
      setResult(null);
    }
  }, [requestId, cacheTtlMs]);

  const handleClick = useCallback(async () => {
    const cached = resultCache.get(requestId);
    if (cached && Date.now() - cached.at < cacheTtlMs) {
      setResult(cached.result);
      return;
    }
    setTesting(true);
    try {
      // Run pre-ping side effects (e.g. persist keys in onboarding). A
      // thrown error or explicit `false` short-circuits and surfaces via
      // the error display; we deliberately don't cache these results
      // because the environment wasn't fully set up.
      if (onBeforePing) {
        const ok = await onBeforePing();
        if (ok === false) {
          setTesting(false);
          return;
        }
      }
      const res = await pingPreset(requestId);
      resultCache.set(requestId, { result: res, at: Date.now() });
      setResult(res);
      onResult?.(res);
    } catch (err) {
      const fallback: PingResult = {
        ok: false,
        latencyMs: 0,
        error: err instanceof Error ? err.message : t("toast.networkError"),
      };
      resultCache.set(requestId, { result: fallback, at: Date.now() });
      setResult(fallback);
      onResult?.(fallback);
    } finally {
      setTesting(false);
    }
  }, [requestId, cacheTtlMs, onResult, onBeforePing]);

  const buttonHeight =
    size === "xs" ? "h-6 text-[10px] px-1.5" : "h-7 text-[11px] px-2.5";

  const latencyDisplay = result?.ok
    ? (result.ttfbMs ?? result.latencyMs)
    : null;
  const resolvedVia = result?.testedTarget?.resolvedVia;
  const fellThrough = resolvedVia === "tag-fallback" || resolvedVia === "any";

  // Compose an informative tooltip — especially useful in the compact
  // variant (icon-only) where the latency/error is not rendered inline.
  const tooltipLines: string[] = [];
  if (result?.testedTarget) {
    tooltipLines.push(
      `${result.testedTarget.provider}/${result.testedTarget.model}`,
    );
    if (result.testedTarget.baseUrl) {
      tooltipLines.push(result.testedTarget.baseUrl);
    }
  }
  if (result?.ok && latencyDisplay !== null) {
    tooltipLines.push(
      t("settings.pingTtfb", {
        ms: latencyDisplay,
        defaultValue: "{{ms}}ms TTFB",
      }),
    );
  } else if (result && !result.ok && result.error) {
    tooltipLines.push(
      t("settings.pingErrorTooltip", {
        error: result.error,
        defaultValue: "Error: {{error}}",
      }),
    );
  }
  if (fellThrough) {
    tooltipLines.push(
      t("settings.pingResolvedVia", {
        resolvedVia,
        defaultValue: "resolved via {{resolvedVia}}",
      }),
    );
  }
  const tooltip =
    tooltipLines.length > 0
      ? tooltipLines.join("\n")
      : t("settings.pingTooltip", "Test connectivity and latency");

  const button = (
    <Button
      variant="outline"
      size="sm"
      className={`${buttonHeight} shrink-0 ${
        result?.ok ? "text-green-600 border-green-500/50" : ""
      } ${result && !result.ok ? "text-destructive border-destructive/50" : ""} ${className ?? ""}`}
      disabled={testing}
      onClick={handleClick}
      title={tooltip}
    >
      {testing ? (
        <Loader2
          className={`${size === "xs" ? "w-2.5 h-2.5" : "w-3 h-3"} animate-spin ${variant === "inline" ? "mr-1" : ""}`}
        />
      ) : (
        <Zap
          className={`${size === "xs" ? "w-2.5 h-2.5" : "w-3 h-3"} ${variant === "inline" ? "mr-1" : ""}`}
        />
      )}
      {variant === "inline" && t("settings.ping", "Ping")}
    </Button>
  );

  if (hideResult) return button;

  const errInfo = result && !result.ok ? classifyPingError(result.error) : null;

  return (
    <span className="inline-flex items-center gap-1.5">
      {button}
      {result && !testing && (
        <span className="inline-flex items-center gap-1 text-xs">
          {result.ok ? (
            <>
              <CheckCircle2 className="w-3 h-3 text-green-500" />
              <span className="text-green-600 font-mono">
                {latencyDisplay}ms
              </span>
              {fellThrough && (
                <span
                  className="text-[10px] text-amber-500"
                  title={t("settings.pingSlotFallbackTitle", {
                    resolvedVia,
                    defaultValue:
                      "Slot fell through to {{resolvedVia}}; the slot you requested is not configured.",
                  })}
                >
                  ⚠
                </span>
              )}
            </>
          ) : (
            <>
              <XCircle className="w-3 h-3 text-destructive" />
              <span
                className="text-destructive font-mono uppercase text-[10px] px-1.5 py-0.5 border border-destructive/40 bg-destructive/5 rounded-sm"
                title={errInfo?.detail ?? result.error}
              >
                {errInfo?.kind ?? "error"}
              </span>
              <span
                className="text-destructive truncate max-w-[180px]"
                title={result.error}
              >
                {result.error?.slice(0, 40) ??
                  t("settings.pingFailed", "Failed")}
              </span>
            </>
          )}
        </span>
      )}
    </span>
  );
}

/** Invalidate the cached ping result for one target (e.g. after key edit). */
export function invalidatePingResult(target: PingTarget): void {
  resultCache.delete(requestIdFor(target));
}
