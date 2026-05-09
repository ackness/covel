import { useTranslation } from "react-i18next";
import { FileJson, MessageSquare, Wrench } from "lucide-react";
import type * as api from "@/services/api.js";
import { categorize, CATEGORY_STYLES, fmtTime } from "./-debug-helpers.js";

export function EventDetail({ event }: { event: api.TraceEvent }) {
  const { t } = useTranslation();
  const displayType =
    event.type === "runtime.progress"
      ? (event.payload.type as string) || event.type
      : event.type;
  const category = categorize(displayType);
  const style = CATEGORY_STYLES[category];

  return (
    <div className="p-3 space-y-3">
      <div
        className={`flex items-center gap-2 px-2 py-1.5 border ${style.border} ${style.bg}`}
      >
        <style.icon className={`w-3.5 h-3.5 ${style.color}`} />
        <span className={`font-mono text-xs font-medium ${style.color}`}>
          {displayType}
        </span>
      </div>

      <div className="space-y-1.5">
        <MetaField label="seq" value={String(event.seq)} />
        <MetaField label="timestamp" value={fmtTime(event.timestamp)} />
        <MetaField label="turnId" value={event.turnId} mono />
        <MetaField label="traceId" value={event.traceId} mono />
        <MetaField label="flowId" value={event.flowId} mono />
        <MetaField label="requestId" value={event.requestId} mono />
      </div>

      {renderStructuredData(displayType, event.payload, t)}

      <details className="group">
        <summary className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center gap-1 cursor-pointer">
          <FileJson className="w-3 h-3" /> {t("debugger.rawPayload")}
        </summary>
        <pre className="text-[10px] font-mono text-muted-foreground bg-muted/20 border border-border p-2 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function renderStructuredData(
  type: string,
  payload: Record<string, unknown>,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  const data = payload.data as Record<string, unknown> | undefined;

  if (type === "llm.calling" && data?.messages) {
    const messages = data.messages as Array<{
      role: string;
      content?: string;
      toolCalls?: unknown[];
      toolCallId?: string;
    }>;
    return (
      <div className="space-y-1.5">
        <h4 className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-1">
          <MessageSquare className="w-3 h-3" />{" "}
          {t("debugger.promptMessages", { count: messages.length })}
        </h4>
        <div className="space-y-1 max-h-[400px] overflow-y-auto">
          {messages.map((message, index) => (
            <div
              key={index}
              className={`border p-2 text-[10px] ${
                message.role === "system"
                  ? "border-blue-500/20 bg-blue-500/5"
                  : message.role === "user"
                    ? "border-emerald-500/20 bg-emerald-500/5"
                    : message.role === "tool"
                      ? "border-violet-500/20 bg-violet-500/5"
                      : "border-amber-500/20 bg-amber-500/5"
              }`}
            >
              <span className="font-mono font-bold text-[9px] uppercase">
                {message.role}
              </span>
              {message.toolCallId && (
                <span className="text-[9px] text-muted-foreground ml-1">
                  ({message.toolCallId})
                </span>
              )}
              <pre className="mt-1 whitespace-pre-wrap break-all text-muted-foreground leading-relaxed max-h-[150px] overflow-y-auto">
                {message.content ||
                  (message.toolCalls
                    ? JSON.stringify(message.toolCalls, null, 2)
                    : "")}
              </pre>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (type === "llm.responded" && data) {
    const usage = data.usage as
      | { inputTokens?: number; outputTokens?: number }
      | undefined;
    const toolCalls = data.toolCalls as
      | Array<{ id: string; name: string; arguments: string }>
      | undefined;
    return (
      <div className="space-y-1.5">
        {usage && (
          <div className="flex gap-3 text-[10px] text-muted-foreground">
            <span>
              {t("debugger.inputTokens")}: {usage.inputTokens ?? 0} tokens
            </span>
            <span>
              {t("debugger.outputTokens")}: {usage.outputTokens ?? 0} tokens
            </span>
          </div>
        )}
        {typeof data.text === "string" && (
          <div>
            <h4 className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">
              {t("debugger.responseText")}
            </h4>
            <pre className="text-[10px] font-mono text-muted-foreground bg-muted/20 border border-border p-2 whitespace-pre-wrap break-all leading-relaxed max-h-[200px] overflow-y-auto">
              {data.text as string}
            </pre>
          </div>
        )}
        {toolCalls && toolCalls.length > 0 && (
          <div>
            <h4 className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">
              {t("debugger.toolCalls", { count: toolCalls.length })}
            </h4>
            {toolCalls.map((toolCall, index) => (
              <div
                key={index}
                className="border border-violet-500/20 bg-violet-500/5 p-2 text-[10px] mb-1"
              >
                <span className="font-mono font-bold">{toolCall.name}</span>
                <pre className="mt-1 whitespace-pre-wrap break-all text-muted-foreground">
                  {toolCall.arguments}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (type === "tool.completed" && data?.result) {
    const resultStr =
      typeof data.result === "string"
        ? data.result
        : JSON.stringify(data.result, null, 2);
    return (
      <div>
        <h4 className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground mb-1 flex items-center gap-1">
          <Wrench className="w-3 h-3" /> {t("debugger.toolResult")}
        </h4>
        <pre className="text-[10px] font-mono text-muted-foreground bg-muted/20 border border-border p-2 whitespace-pre-wrap break-all leading-relaxed max-h-[200px] overflow-y-auto">
          {resultStr}
        </pre>
      </div>
    );
  }

  if (type === "tool.calling" && payload.detail) {
    return (
      <div>
        <h4 className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground mb-1 flex items-center gap-1">
          <Wrench className="w-3 h-3" /> {t("debugger.toolInput")}
        </h4>
        <pre className="text-[10px] font-mono text-muted-foreground bg-muted/20 border border-border p-2 whitespace-pre-wrap break-all leading-relaxed">
          {(() => {
            try {
              return JSON.stringify(
                JSON.parse(payload.detail as string),
                null,
                2,
              );
            } catch {
              return payload.detail as string;
            }
          })()}
        </pre>
      </div>
    );
  }

  return null;
}

function MetaField({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  if (!value) return null;
  return (
    <div className="flex items-baseline gap-2 text-[10px]">
      <span className="text-muted-foreground shrink-0 min-w-[70px]">
        {label}
      </span>
      <span className={`truncate ${mono ? "font-mono" : ""} text-foreground`}>
        {value}
      </span>
    </div>
  );
}
