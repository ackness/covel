import { diagnosticErrorKind } from "@covel/shared";

export interface SseDiagnostic {
  readonly type:
    | "reader-done"
    | "read-error"
    | "parse-error"
    | "message-error"
    | "abort"
    | "cancel"
    | "cancel-error"
    | "body-missing";
  readonly errorKind?: string;
}

export interface SseMessage {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
}

export interface ReadSseStreamOptions<T> {
  readonly response: Response;
  readonly signal?: AbortSignal;
  readonly parse: (data: string, message: SseMessage) => T | undefined;
  readonly onMessage: (event: T) => void;
  /** Transport metadata only; observers never receive content or raw errors. */
  readonly onDiagnostic?: (diagnostic: SseDiagnostic) => void;
}

export async function readSseStream<T>(
  options: ReadSseStreamOptions<T>,
): Promise<void> {
  const reader = options.response.body?.getReader();
  if (!reader) {
    options.onDiagnostic?.({ type: "body-missing" });
    throw new Error("No response body for SSE stream");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let eventId = "";
  let eventType = "";
  let dataLines: string[] = [];
  let skipLf = false;
  let finished = false;
  let phase: "read" | "parse" | "message" = "read";

  const dispatch = (): void => {
    if (dataLines.length === 0) return;
    const eventData = dataLines.join("\n");
    const message: SseMessage = {
      ...(eventId ? { id: eventId } : {}),
      ...(eventType ? { event: eventType } : {}),
      data: eventData,
    };
    phase = "parse";
    const parsed = options.parse(eventData, message);
    if (parsed !== undefined) {
      phase = "message";
      options.onMessage(parsed);
    }
    phase = "read";
  };

  const consumeLine = (line: string): void => {
    if (line === "") {
      dispatch();
      eventId = "";
      eventType = "";
      dataLines = [];
      return;
    }
    if (line.startsWith(":")) return;

    const colon = line.indexOf(":");
    const field = colon >= 0 ? line.slice(0, colon) : line;
    const rawValue = colon >= 0 ? line.slice(colon + 1) : "";
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "id") {
      eventId = value;
    } else if (field === "event") {
      eventType = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  };

  const cancel = async () => {
    options.onDiagnostic?.({ type: "cancel" });
    await reader.cancel().catch((error: unknown) => {
      options.onDiagnostic?.({
        type: "cancel-error",
        errorKind: diagnosticErrorKind(error),
      });
    });
  };
  const onAbort = () => {
    options.onDiagnostic?.({ type: "abort" });
    void cancel();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (options.signal?.aborted) options.onDiagnostic?.({ type: "abort" });
    while (!options.signal?.aborted) {
      const { done, value } = await reader.read();
      finished = done;
      if (options.signal?.aborted) return;
      const chunk = decoder.decode(value, { stream: !done });
      let start = 0;
      if (skipLf && chunk.length > 0) {
        if (chunk.startsWith("\n")) start = 1;
        skipLf = false;
      }
      const endings = /\r\n|\r|\n/g;
      endings.lastIndex = start;
      for (
        let match = endings.exec(chunk);
        match;
        match = endings.exec(chunk)
      ) {
        buffer += chunk.slice(start, match.index);
        consumeLine(buffer);
        buffer = "";
        start = endings.lastIndex;
        skipLf = match[0] === "\r" && start === chunk.length;
      }
      buffer += chunk.slice(start);
      if (done) {
        options.onDiagnostic?.({ type: "reader-done" });
        break;
      }
    }
    // An interrupted frame is not committed by EOF; only a blank line dispatches.
  } catch (error) {
    options.onDiagnostic?.({
      type: `${phase}-error`,
      errorKind: diagnosticErrorKind(error),
    });
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (!finished) await cancel();
    reader.releaseLock();
  }
}

export function parseJsonSseData<T>(
  data: string,
  _message?: SseMessage,
  onError?: () => void,
): T | undefined {
  const trimmed = data.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    onError?.();
    return undefined;
  }
}
