import type { SseEvent } from "../transport/transport.js";

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();

  let buffer = "";
  let currentType = "";
  let currentId: string | undefined;
  let currentRetry: number | undefined;
  let currentDataLines: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // Emit any remaining buffered event on stream close
        if (currentDataLines.length > 0) {
          const raw = currentDataLines.join("\n");
          let data: unknown = raw;
          try {
            data = JSON.parse(raw) as unknown;
          } catch {
            // keep raw string
          }
          yield {
            type: currentType || "message",
            data,
            ...(currentId !== undefined ? { id: currentId } : {}),
            ...(currentRetry !== undefined ? { retry: currentRetry } : {}),
          };
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line === "") {
          // Empty line = dispatch event
          if (currentDataLines.length > 0) {
            const raw = currentDataLines.join("\n");
            let data: unknown = raw;
            try {
              data = JSON.parse(raw) as unknown;
            } catch {
              // keep raw string
            }
            yield {
              type: currentType || "message",
              data,
              ...(currentId !== undefined ? { id: currentId } : {}),
              ...(currentRetry !== undefined ? { retry: currentRetry } : {}),
            };
          }
          // Reset for next event
          currentType = "";
          currentId = undefined;
          currentRetry = undefined;
          currentDataLines = [];
        } else if (line.startsWith("event:")) {
          currentType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          currentDataLines.push(line.slice(5).trimStart());
        } else if (line.startsWith("id:")) {
          currentId = line.slice(3).trim();
        } else if (line.startsWith("retry:")) {
          const retryVal = Number(line.slice(6).trim());
          if (!isNaN(retryVal)) currentRetry = retryVal;
        }
        // Lines starting with ':' are comments — ignore them
      }
    }
  } finally {
    reader.releaseLock();
  }
}
