import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Copy,
  FileJson,
  MessageSquare,
  Wrench,
} from "lucide-react";
import type * as api from "@/services/api.js";
import {
  categorize,
  CATEGORY_STYLES,
  fmtTime,
  getDisplayType,
  getTraceData,
  getTraceError,
} from "./-debug-helpers.js";

export function EventDetail({
  event,
  relatedEvents = [],
}: {
  event: api.TraceEvent;
  relatedEvents?: readonly api.TraceEvent[];
}) {
  const { t } = useTranslation();
  const displayType = getDisplayType(event);
  const category = categorize(displayType);
  const style = CATEGORY_STYLES[category];
  const data = getTraceData(event.payload);
  const diagnostic = event.diagnostic;
  const error = getTraceError(event);
  const toolInvocation = findToolInvocation(event, relatedEvents);

  return (
    <div className="p-4 space-y-4">
      <div
        className={`flex items-center gap-2 px-2.5 py-2 border ${error ? "border-destructive/30 bg-destructive/5" : `${style.border} ${style.bg}`}`}
      >
        {error ? (
          <AlertTriangle className="w-3.5 h-3.5 text-destructive" />
        ) : (
          <style.icon className={`w-3.5 h-3.5 ${style.color}`} />
        )}
        <span
          className={`font-mono text-xs font-medium ${error ? "text-destructive" : style.color}`}
        >
          {displayType}
          {toolInvocation?.name ? ` · ${toolInvocation.name}` : ""}
        </span>
        <span className="ml-auto font-mono text-[9px] text-muted-foreground">
          #{event.seq}
        </span>
      </div>

      {error && (
        <section className="border border-destructive/30 bg-destructive/5 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-[9px] font-semibold uppercase tracking-widest text-destructive flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> {t("debugger.errorDetail")}
            </h4>
            <CopyButton value={formatValue(error)} label={t("common.copy")} />
          </div>
          {error.code && (
            <div className="font-mono text-[10px] text-destructive/80">
              {error.code}
            </div>
          )}
          <pre className="whitespace-pre-wrap wrap-break-word font-mono text-[11px] leading-relaxed text-foreground select-text">
            {error.message}
          </pre>
          {error.details != null && (
            <CodeBlock value={error.details} className="max-h-48" />
          )}
        </section>
      )}

      {!error && diagnostic?.warning?.code === "slow" && (
        <section className="border border-amber-500/30 bg-amber-500/5 p-3 space-y-1">
          <h4 className="text-[9px] font-semibold uppercase tracking-widest text-amber-500 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" />
            {t("debugger.slowWarning")}
          </h4>
          <p className="text-[10px] text-muted-foreground">
            {t("debugger.slowWarningDetail", {
              duration: diagnostic.durationMs ?? 0,
              threshold: diagnostic.warning.thresholdMs,
            })}
          </p>
        </section>
      )}

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-x-5 gap-y-1.5">
        <MetaField label="eventId" value={event.id} mono />
        <MetaField label="timestamp" value={fmtTime(event.timestamp)} />
        <MetaField
          label="requestStartedAt"
          value={
            diagnostic?.startedAt
              ? fmtTime(diagnostic.startedAt)
              : stringValue(data.startedAt)
                ? fmtTime(String(data.startedAt))
                : undefined
          }
        />
        <MetaField label="turnId" value={event.turnId} mono />
        <MetaField label="traceId" value={event.traceId} mono />
        <MetaField label="flowId" value={event.flowId} mono />
        <MetaField label="requestId" value={event.requestId} mono />
        <MetaField
          label="runtimeId"
          value={diagnostic?.runtimeId ?? stringValue(data.runtimeId)}
          mono
        />
        <MetaField
          label="pluginId"
          value={diagnostic?.pluginId ?? stringValue(data.pluginId)}
          mono
        />
        <MetaField
          label="stage"
          value={diagnostic?.stage ?? stringValue(data.stage)}
        />
        <MetaField
          label="operation"
          value={
            diagnostic?.operation ??
            stringValue(data.toolName) ??
            stringValue(data.method) ??
            stringValue(data.hookName)
          }
          mono
        />
        <MetaField
          label="provider/model"
          value={
            [
              diagnostic?.provider ?? stringValue(data.provider),
              diagnostic?.model ?? stringValue(data.model),
            ]
              .filter(Boolean)
              .join(" / ") || undefined
          }
          mono
        />
        <MetaField
          label="slot/attempt"
          value={
            [
              diagnostic?.slot ?? stringValue(data.slot),
              diagnostic?.attempt != null
                ? `#${diagnostic.attempt}`
                : typeof data.attempt === "number"
                  ? `#${data.attempt}`
                  : undefined,
            ]
              .filter(Boolean)
              .join(" / ") || undefined
          }
          mono
        />
        <MetaField
          label="duration"
          value={
            diagnostic?.durationMs != null
              ? `${diagnostic.durationMs}ms`
              : typeof data.durationMs === "number"
                ? `${data.durationMs}ms`
                : undefined
          }
          mono
        />
      </section>

      {renderStructuredData(displayType, data, diagnostic, toolInvocation, t)}

      <details className="group">
        <summary className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center gap-1 cursor-pointer">
          <FileJson className="w-3 h-3" /> {t("debugger.rawPayload")}
        </summary>
        <div className="relative">
          <CopyButton
            value={formatValue(event.payload)}
            label={t("common.copy")}
            className="absolute right-2 top-2"
          />
          <CodeBlock value={event.payload} className="max-h-120 pr-16" />
        </div>
      </details>
    </div>
  );
}

function renderStructuredData(
  type: string,
  data: Record<string, unknown>,
  diagnostic: api.TraceEventDiagnostic | undefined,
  toolInvocation: ToolInvocation | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  if (type === "llm.calling") {
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const tools = Array.isArray(data.tools) ? data.tools : [];
    return (
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
          <span className="border border-blue-500/20 bg-blue-500/5 px-1.5 py-0.5">
            {t("debugger.promptMessages", { count: messages.length })}
          </span>
          <span>
            {t("debugger.characterCount", {
              count:
                diagnostic?.prompt?.promptChars ?? countMessageChars(messages),
            })}
          </span>
          <span>{t("debugger.promptTools", { count: tools.length })}</span>
          {diagnostic?.prompt?.contentPath && (
            <span className="font-mono text-[9px] opacity-70">
              {diagnostic.prompt.contentPath}
            </span>
          )}
        </div>

        <div className="space-y-2">
          {messages.map((rawMessage, index) => {
            const message = isRecord(rawMessage) ? rawMessage : {};
            const role = stringValue(message.role) ?? "unknown";
            const content = message.content ?? "";
            const messageToolCalls = message.toolCalls ?? message.tool_calls;
            const toolCallId = message.toolCallId ?? message.tool_call_id;
            return (
              <div
                key={index}
                className={`border p-3 text-[10px] ${roleStyle(role)}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-bold text-[9px] uppercase">
                    {role} · #{index + 1}
                  </span>
                  <CopyButton
                    value={formatValue(message)}
                    label={t("common.copy")}
                  />
                </div>
                {toolCallId != null && (
                  <div className="mt-1 font-mono text-[9px] text-muted-foreground">
                    toolCallId: {String(toolCallId)}
                  </div>
                )}
                {formatValue(content) && (
                  <pre className="mt-2 whitespace-pre-wrap wrap-break-word text-foreground/85 leading-relaxed max-h-120 overflow-y-auto select-text">
                    {formatValue(content)}
                  </pre>
                )}
                {messageToolCalls != null && (
                  <div className="mt-2 border-t border-border/40 pt-2">
                    <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {t("debugger.messageToolCalls")}
                    </div>
                    <CodeBlock value={messageToolCalls} className="max-h-64" />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {tools.length > 0 && (
          <details>
            <summary className="cursor-pointer text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
              {t("debugger.availableTools", { count: tools.length })}
            </summary>
            <CodeBlock value={tools} className="mt-1 max-h-80" />
          </details>
        )}
      </section>
    );
  }

  if (type === "gateway.calling") {
    return (
      <section className="border border-amber-500/20 bg-amber-500/5 p-3 space-y-1">
        <h4 className="text-[9px] font-semibold uppercase tracking-widest text-amber-500">
          {t("debugger.promptSummary")}
        </h4>
        <p className="text-[10px] text-muted-foreground">
          {t("debugger.promptContentUnavailable", {
            count: diagnostic?.prompt?.messageCount ?? data.messageCount ?? 0,
            chars: diagnostic?.prompt?.promptChars ?? data.promptChars ?? 0,
          })}
        </p>
      </section>
    );
  }

  if (type === "llm.responded") {
    const usage = isRecord(data.usage) ? data.usage : undefined;
    const toolCalls = Array.isArray(data.toolCalls) ? data.toolCalls : [];
    return (
      <section className="space-y-3">
        <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
          {usage && (
            <>
              <span>
                {t("debugger.inputTokens")}: {String(usage.inputTokens ?? 0)}
              </span>
              <span>
                {t("debugger.outputTokens")}: {String(usage.outputTokens ?? 0)}
              </span>
            </>
          )}
          {data.finishReason != null && (
            <span>finishReason: {String(data.finishReason)}</span>
          )}
        </div>
        {typeof data.text === "string" && (
          <DetailSection
            title={t("debugger.responseText")}
            value={data.text}
            copyLabel={t("common.copy")}
          />
        )}
        {toolCalls.length > 0 && (
          <section className="space-y-2">
            <h4 className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-1">
              <Wrench className="w-3 h-3" />
              {t("debugger.toolCalls", { count: toolCalls.length })}
            </h4>
            {toolCalls.map((rawCall, index) => (
              <ToolCallCard
                key={index}
                call={isRecord(rawCall) ? rawCall : { arguments: rawCall }}
                t={t}
              />
            ))}
          </section>
        )}
      </section>
    );
  }

  if (type.startsWith("tool.")) {
    return toolInvocation ? (
      <ToolInvocationDetail invocation={toolInvocation} t={t} />
    ) : null;
  }

  if (type === "message.completed" && data.content != null) {
    return (
      <DetailSection
        icon={<MessageSquare className="w-3 h-3" />}
        title={t("debugger.responseText")}
        value={data.content}
        copyLabel={t("common.copy")}
      />
    );
  }

  return null;
}

interface ToolInvocation {
  name?: string;
  callId?: string;
  input?: unknown;
  output?: unknown;
  status: "calling" | "succeeded" | "failed";
  durationMs?: number;
  error?: ReturnType<typeof getTraceError>;
}

function findToolInvocation(
  event: api.TraceEvent,
  relatedEvents: readonly api.TraceEvent[],
): ToolInvocation | undefined {
  const displayType = getDisplayType(event);
  if (!displayType.startsWith("tool.")) return undefined;

  const selectedData = getTraceData(event.payload);
  const callId =
    event.diagnostic?.tool?.callId ?? stringValue(selectedData.toolCallId);
  const candidates = callId
    ? [event, ...relatedEvents].filter((candidate, index, all) => {
        if (all.indexOf(candidate) !== index) return false;
        const candidateData = getTraceData(candidate.payload);
        return (
          (candidate.diagnostic?.tool?.callId ??
            stringValue(candidateData.toolCallId)) === callId
        );
      })
    : [event];

  const calling = candidates.find(
    (candidate) => getDisplayType(candidate) === "tool.calling",
  );
  const terminal = candidates.find((candidate) => {
    const type = getDisplayType(candidate);
    return type === "tool.completed" || type === "tool.failed";
  });
  const callingData = calling ? getTraceData(calling.payload) : selectedData;
  const terminalData = terminal ? getTraceData(terminal.payload) : selectedData;
  const terminalType = terminal ? getDisplayType(terminal) : displayType;
  const invocationError = terminal
    ? getTraceError(terminal)
    : getTraceError(event);

  return {
    name:
      calling?.diagnostic?.tool?.name ??
      terminal?.diagnostic?.tool?.name ??
      event.diagnostic?.tool?.name ??
      stringValue(callingData.toolName) ??
      stringValue(terminalData.toolName) ??
      stringValue(callingData.label),
    ...(callId ? { callId } : {}),
    ...(callingData.arguments !== undefined
      ? { input: callingData.arguments }
      : callingData.detail !== undefined
        ? { input: callingData.detail }
        : {}),
    ...(terminalData.parsedResult !== undefined
      ? { output: terminalData.parsedResult }
      : terminalData.result !== undefined
        ? { output: terminalData.result }
        : {}),
    status:
      terminalType === "tool.failed" || invocationError
        ? "failed"
        : terminalType === "tool.completed"
          ? "succeeded"
          : "calling",
    ...(terminal?.diagnostic?.tool?.durationMs != null
      ? { durationMs: terminal.diagnostic.tool.durationMs }
      : typeof terminalData.durationMs === "number"
        ? { durationMs: terminalData.durationMs }
        : {}),
    ...(invocationError ? { error: invocationError } : {}),
  };
}

function ToolInvocationDetail({
  invocation,
  t,
}: {
  invocation: ToolInvocation;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const statusClass =
    invocation.status === "failed"
      ? "text-destructive"
      : invocation.status === "succeeded"
        ? "text-emerald-500"
        : "text-amber-500";
  return (
    <section className="border border-violet-500/25 bg-violet-500/5 p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[9px] font-semibold uppercase tracking-widest text-violet-500">
            {t("debugger.toolInvocation")}
          </div>
          <div className="mt-1 font-mono text-xs font-semibold break-all">
            {invocation.name
              ? `${invocation.name}()`
              : t("debugger.unknownTool")}
          </div>
          {invocation.callId && (
            <div className="mt-1 font-mono text-[9px] text-muted-foreground break-all">
              callId: {invocation.callId}
            </div>
          )}
        </div>
        <div className={`font-mono text-[9px] ${statusClass}`}>
          {t(`debugger.toolStatus.${invocation.status}`)}
          {invocation.durationMs != null ? ` · ${invocation.durationMs}ms` : ""}
        </div>
      </div>
      {invocation.input !== undefined && (
        <DetailSection
          title={t("debugger.toolInputParameters")}
          value={invocation.input}
          copyLabel={t("common.copy")}
        />
      )}
      {invocation.output !== undefined && (
        <DetailSection
          title={t("debugger.toolOutputResult")}
          value={invocation.output}
          copyLabel={t("common.copy")}
        />
      )}
      {invocation.error && (
        <DetailSection
          title={t("debugger.errorDetail")}
          value={invocation.error}
          copyLabel={t("common.copy")}
        />
      )}
    </section>
  );
}

function ToolCallCard({
  call,
  t,
}: {
  call: Record<string, unknown>;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const name = stringValue(call.name) ?? stringValue(call.toolName);
  const callId = stringValue(call.id) ?? stringValue(call.toolCallId);
  return (
    <div className="border border-violet-500/20 bg-violet-500/5 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-mono text-[11px] font-semibold">
            {name ? `${name}()` : t("debugger.unknownTool")}
          </div>
          {callId && (
            <div className="mt-0.5 font-mono text-[9px] text-muted-foreground">
              callId: {callId}
            </div>
          )}
        </div>
        <CopyButton value={formatValue(call)} label={t("common.copy")} />
      </div>
      <div className="mt-2">
        <CodeBlock
          value={call.arguments ?? call.input ?? {}}
          className="max-h-80"
        />
      </div>
    </div>
  );
}

function DetailSection({
  title,
  value,
  copyLabel,
  icon,
}: {
  title: string;
  value: unknown;
  copyLabel: string;
  icon?: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h4 className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-1">
          {icon} {title}
        </h4>
        <CopyButton value={formatValue(value)} label={copyLabel} />
      </div>
      <CodeBlock value={value} className="max-h-120" />
    </section>
  );
}

function CodeBlock({
  value,
  className = "",
}: {
  value: unknown;
  className?: string;
}) {
  return (
    <pre
      className={`text-[10px] font-mono text-foreground/85 bg-muted/20 border border-border p-2.5 overflow-auto whitespace-pre-wrap wrap-break-word leading-relaxed select-text ${className}`}
    >
      {formatValue(value)}
    </pre>
  );
}

function CopyButton({
  value,
  label,
  className = "",
}: {
  value: string;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={`inline-flex items-center gap-1 border border-border bg-background/80 px-1.5 py-0.5 text-[9px] text-muted-foreground hover:text-foreground ${className}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).catch(() => undefined);
      }}
    >
      <Copy className="h-2.5 w-2.5" />
      {label}
    </button>
  );
}

function MetaField({
  label,
  value,
  mono,
}: {
  label: string;
  value?: string;
  mono?: boolean;
}) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2 text-[10px] min-w-0">
      <span className="text-muted-foreground shrink-0 min-w-24">{label}</span>
      <span
        className={`min-w-0 break-all select-text ${mono ? "font-mono" : ""} text-foreground`}
      >
        {value}
      </span>
    </div>
  );
}

function roleStyle(role: string): string {
  if (role === "system") return "border-blue-500/20 bg-blue-500/5";
  if (role === "user") return "border-emerald-500/20 bg-emerald-500/5";
  if (role === "tool") return "border-violet-500/20 bg-violet-500/5";
  return "border-amber-500/20 bg-amber-500/5";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function countMessageChars(messages: unknown[]): number {
  return messages.reduce<number>((total, rawMessage) => {
    if (!isRecord(rawMessage)) return total;
    return total + formatValue(rawMessage.content).length;
  }, 0);
}
