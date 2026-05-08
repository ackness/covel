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
  let eventData = "";

  const dispatch = (): void => {
    if (!eventData) return;
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
      eventData = "";
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
      eventData = eventData ? `${eventData}\n${value}` : value;
    }
  };

  while (true) {
    if (options.signal?.aborted) return;
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
  }

  const tail = decoder.decode();
  if (tail) buffer += tail;
  if (buffer) consumeLine(buffer);
  dispatch();
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
