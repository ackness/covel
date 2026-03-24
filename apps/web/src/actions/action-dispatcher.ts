import type { ActionRequest, SseEnvelope } from "../../../../modules/contracts/src/index.js";
import { getStoredLocale } from "../i18n.js";

export async function dispatchActionWithSse(input: {
  runtimeBaseUrl: string;
  action: ActionRequest;
  onEnvelope(envelope: SseEnvelope): void | Promise<void>;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const locale = input.action.locale ?? getStoredLocale();
  const response = await fetchImpl(`${input.runtimeBaseUrl}/actions`, {
    method: "POST",
    headers: {
      "accept-language": locale,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      ...input.action,
      locale
    })
  });

  if (!response.ok || !response.body) {
    throw new Error(`Action request failed with status ${response.status}.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawTerminalEvent = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (buffer.includes("\n\n")) {
      const boundary = buffer.indexOf("\n\n");
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = frame
        .split("\n")
        .find((line) => line.startsWith("data: "));

      if (!dataLine) {
        continue;
      }

      const envelope = JSON.parse(dataLine.slice(6)) as SseEnvelope;
      await input.onEnvelope(envelope);

      if (envelope.type === "flow.completed" || envelope.type === "flow.failed") {
        sawTerminalEvent = true;
      }
    }
  }

  if (!sawTerminalEvent) {
    throw new Error("Action stream must terminate with flow.completed or flow.failed.");
  }
}
