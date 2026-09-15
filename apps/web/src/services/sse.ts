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
}

export async function readSseStream<T>(
  options: ReadSseStreamOptions<T>,
): Promise<void> {
  const reader = options.response.body?.getReader();
  if (!reader) throw new Error("No response body for SSE stream");

  const decoder = new TextDecoder();
  let buffer = "";
  let eventId = "";
  let eventType = "";
  let dataLines: string[] = [];
  let skipLf = false;
  let finished = false;

  const dispatch = (): void => {
    if (dataLines.length === 0) return;
    const eventData = dataLines.join("\n");
    const message: SseMessage = {
      ...(eventId ? { id: eventId } : {}),
      ...(eventType ? { event: eventType } : {}),
      data: eventData,
    };
    const parsed = options.parse(eventData, message);
    if (parsed !== undefined) options.onMessage(parsed);
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

  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
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
      if (done) break;
    }
    // An interrupted frame is not committed by EOF; only a blank line dispatches.
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function parseJsonSseData<T>(data: string): T | undefined {
  const trimmed = data.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return undefined;
  }
}
