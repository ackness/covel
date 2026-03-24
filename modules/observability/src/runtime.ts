export interface AppLogEntry {
  level: "info" | "warn" | "error";
  message: string;
  requestId: string;
  traceId: string;
  sessionId: string;
  payload: Record<string, unknown>;
}

export interface AuditLogEntry {
  action: string;
  requestId: string;
  traceId: string;
  sessionId: string;
  actorId?: string;
  payload: Record<string, unknown>;
}

export interface TraceEntry {
  traceId: string;
  spanId: string;
  sessionId: string;
  turnId: string;
  component: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export function createObservability() {
  const appLogs: AppLogEntry[] = [];
  const auditLogs: AuditLogEntry[] = [];
  const traces: TraceEntry[] = [];

  return {
    recordAppLog(entry: AppLogEntry) {
      appLogs.push({
        ...entry,
        payload: redactSecrets(entry.payload)
      });
    },
    recordAuditLog(entry: AuditLogEntry) {
      auditLogs.push({
        ...entry,
        payload: redactSecrets(entry.payload)
      });
    },
    recordTrace(entry: TraceEntry) {
      traces.push({
        ...entry,
        payload: redactSecrets(entry.payload)
      });
    },
    listAppLogs() {
      return [...appLogs];
    },
    listAuditLogs() {
      return [...auditLogs];
    },
    listTracesByTraceId(traceId: string) {
      return traces.filter((entry) => entry.traceId === traceId);
    }
  };
}

function redactSecrets(value: unknown): any {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => {
        if (isSensitiveKey(key)) {
          return [key, "[REDACTED]"];
        }

        return [key, redactSecrets(nestedValue)];
      })
    );
  }

  return value;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.includes("apikey") || normalized.includes("api_key") || normalized === "authorization";
}
