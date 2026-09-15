import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { resolveProviderRequestBody } from "@covel/shared";
import type { TraceEvent } from "@/services/api.js";
import { getTraceData, traceEventIdentity } from "./-debug-helpers.js";
import { llmAttempts } from "./-llm-attempts.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function LLMRequestInspector({
  event,
  logical,
}: {
  event: TraceEvent;
  logical: ReactNode;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"provider" | "logical">("provider");
  const data = getTraceData(event.payload);
  const requests = Array.isArray(data.providerRequests)
    ? data.providerRequests
    : [];
  return (
    <section className="space-y-3" data-testid="llm-request-inspector">
      <div
        className="flex gap-2"
        role="tablist"
        aria-label={t("debugger.requestView")}
      >
        {(["provider", "logical"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
            className="rounded border px-3 py-2 text-xs aria-selected:bg-primary/15"
          >
            {t(`debugger.${value}Request`)}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {mode === "logical" ? (
          logical
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {t("debugger.providerRequestHint")}
            </p>
            {requests.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {t("debugger.providerRequestUnavailable")}
              </p>
            )}
            {requests.map((request, index) => {
              if (!isRecord(request)) return null;
              const body = resolveProviderRequestBody(requests, index);
              return (
                <section key={index} className="space-y-2 rounded border p-3">
                  <div className="flex flex-wrap gap-2 text-xs font-mono">
                    <span>
                      #{index + 1} · {String(request.provider ?? "")} /{" "}
                      {String(request.protocol ?? "")}
                    </span>
                    <span>HTTP {String(request.statusCode ?? "—")}</span>
                    <span>
                      {t("debugger.transportAttempt")}:{" "}
                      {String(request.transportAttempt ?? 0)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("debugger.httpHeadersDuration")}:{" "}
                    {typeof request.durationMs === "number"
                      ? `${request.durationMs} ms`
                      : "—"}
                  </p>
                  {request.complete !== true && (
                    <p className="text-xs text-amber-600">
                      {t("debugger.requestOmitted", {
                        count:
                          typeof request.omittedFieldCount === "number"
                            ? request.omittedFieldCount
                            : 0,
                      })}
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={!body}
                    className="rounded border px-2 py-1 text-xs"
                    onClick={() => {
                      void navigator.clipboard
                        ?.writeText(JSON.stringify(body, null, 2))
                        .catch(() => undefined);
                    }}
                  >
                    {t("debugger.copyProviderBody")}
                  </button>
                  <pre className="max-h-120 overflow-auto whitespace-pre-wrap wrap-break-word border bg-muted/20 p-2 text-xs select-text">
                    {body
                      ? JSON.stringify(body, null, 2)
                      : t("debugger.providerRequestUnavailable")}
                  </pre>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

export function RuntimeAttemptHistory({
  event,
  relatedEvents,
}: {
  event: TraceEvent;
  relatedEvents: readonly TraceEvent[];
}) {
  const { t } = useTranslation();
  const attempts = llmAttempts(event, relatedEvents);
  if (attempts.length === 0) return null;
  return (
    <details className="space-y-2" open>
      <summary className="cursor-pointer text-xs font-semibold">
        {t("debugger.attemptHistory")}
      </summary>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr>
              {[
                "callAttempt",
                "queueWait",
                "modelDuration",
                "attemptOutcome",
              ].map((key) => (
                <th key={key} className="p-2 font-medium text-muted-foreground">
                  {t(`debugger.${key}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {attempts.map((item) => {
              const data = getTraceData(item.calling.payload);
              const duration =
                item.response && getTraceData(item.response.payload).durationMs;
              return (
                <tr
                  key={traceEventIdentity(item.calling)}
                  className="border-t border-border"
                >
                  <td className="p-2">
                    {item.call} / {item.attempt + 1}
                  </td>
                  <td className="p-2">
                    {typeof data.queueWaitMs === "number"
                      ? `${data.queueWaitMs} ms`
                      : "—"}
                  </td>
                  <td className="p-2">
                    {typeof duration === "number" ? `${duration} ms` : "—"}
                  </td>
                  <td
                    className={`p-2 ${item.status === "failed" ? "text-destructive" : item.status === "recovered" ? "text-amber-600" : ""}`}
                  >
                    {t(`debugger.attemptStatus.${item.status}`)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("debugger.attemptTimingHint")}
      </p>
    </details>
  );
}
