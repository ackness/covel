import type { ScopedLogger, LoggerFields } from "./types.js";

type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogSink {
  write(entry: LogEntry): void;
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  fields: Record<string, unknown>;
  error?: Error | unknown;
  timestamp: string;
}

const defaultSink: LogSink = {
  write(entry: LogEntry): void {
    const prefix = Object.entries(entry.fields)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    const tag = prefix ? `[${prefix}]` : "";
    const msg = `${entry.timestamp} ${entry.level.toUpperCase()} ${tag} ${entry.message}`;

    switch (entry.level) {
      case "debug":
        console.debug(msg, entry.error ?? "");
        break;
      case "info":
        console.info(msg);
        break;
      case "warn":
        console.warn(msg, entry.error ?? "");
        break;
      case "error":
        console.error(msg, entry.error ?? "");
        break;
    }
  },
};

export function createScopedLogger(
  fields: LoggerFields,
  sink: LogSink = defaultSink,
): ScopedLogger {
  function log(level: LogLevel, message: string, errorOrData?: Error | unknown, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      level,
      message,
      fields: { ...fields, ...data },
      error: errorOrData instanceof Error ? errorOrData : undefined,
      timestamp: new Date().toISOString(),
    };
    // If errorOrData is not an Error but is provided as data
    if (errorOrData && !(errorOrData instanceof Error) && !data) {
      entry.fields = { ...fields, ...(errorOrData as Record<string, unknown>) };
      entry.error = undefined;
    }
    sink.write(entry);
  }

  return {
    debug(message: string, data?: Record<string, unknown>): void {
      log("debug", message, undefined, data);
    },
    info(message: string, data?: Record<string, unknown>): void {
      log("info", message, undefined, data);
    },
    warn(message: string, data?: Record<string, unknown>): void {
      log("warn", message, undefined, data);
    },
    error(message: string, error?: Error | unknown, data?: Record<string, unknown>): void {
      log("error", message, error, data);
    },
    child(extraFields: Record<string, unknown>): ScopedLogger {
      return createScopedLogger({ ...fields, ...extraFields }, sink);
    },
  };
}
