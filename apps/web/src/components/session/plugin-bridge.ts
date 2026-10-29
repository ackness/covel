import { z } from "zod";
import { PLUGIN_FRAME_CSP, PLUGIN_BRIDGE_SCRIPT } from "@covel/shared";

/**
 * The plugin's document as the frame host (`public/plugin-frame.html`) loads
 * it: the bridge script, then the plugin's HTML. The frame host's policy is
 * inherited; the copy here keeps the document closed if it is ever rendered
 * somewhere else.
 */
export function pluginFrameDocument(html: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${PLUGIN_FRAME_CSP}"><script>${PLUGIN_BRIDGE_SCRIPT}</script>${html}`;
}

/** A message that can be answered: anything else from the frame is dropped. */
const actionEnvelope = z.looseObject({
  type: z.literal("action"),
  id: z.string().min(1).max(80),
});
const actionRequest = z.object({
  action: z.string().min(1).max(120),
  params: z.record(z.string(), z.unknown()),
});

/** Requests one frame may have in progress; more are dropped unanswered. */
const MAX_IN_FLIGHT = 8;

export type PluginBridgeHandler = (params: Record<string, unknown>) => unknown;

export interface PluginBridgeHost {
  state: Readonly<Record<string, unknown>>;
  locked: boolean;
  handlers: Readonly<Record<string, PluginBridgeHandler>>;
}

export interface PluginBridge {
  pushState(state: Readonly<Record<string, unknown>>): void;
  pushStream(seq: number, append: string): void;
  close(): void;
}

/**
 * Connect the app to the plugin document in one frame.
 *
 * The app listens on no window `message` event: the only channel is a
 * `MessagePort` whose other end is transferred to `target`, the frame's own
 * `contentWindow`, so no other window can address the bridge. What arrives on
 * the port is plugin-controlled input. It can name one of the handlers the
 * host offers and nothing else; a failure is answered with a fixed text, so
 * a server error or a credential in it never reaches plugin HTML.
 */
export function connectPluginBridge(
  target: Pick<Window, "postMessage">,
  html: string | undefined,
  host: () => PluginBridgeHost,
  options?: { onReady?: () => void },
): PluginBridge {
  const channel = new MessageChannel();
  const port = channel.port1;
  const inFlight = new Set<string>();
  port.onmessage = async ({ data }: MessageEvent<unknown>) => {
    if (
      data &&
      typeof data === "object" &&
      "type" in data &&
      data.type === "ready"
    ) {
      options?.onReady?.();
      return;
    }
    const envelope = actionEnvelope.safeParse(data);
    if (!envelope.success) return;
    const { id } = envelope.data;
    if (inFlight.has(id) || inFlight.size >= MAX_IN_FLIGHT) return;
    inFlight.add(id);
    try {
      const request = actionRequest.safeParse(envelope.data);
      if (!request.success) throw new Error("Invalid plugin UI action");
      const { locked, handlers } = host();
      const handler = Object.hasOwn(handlers, request.data.action)
        ? handlers[request.data.action]
        : undefined;
      if (locked || !handler)
        throw new Error("Plugin UI action is unavailable");
      const value = await handler(request.data.params);
      port.postMessage({ type: "result", id, value });
    } catch {
      port.postMessage({
        type: "result",
        id,
        error: "Plugin UI action failed",
      });
    } finally {
      inFlight.delete(id);
    }
  };
  // The frame is an opaque origin, which no target origin but "*" matches.
  // The message carries the plugin's own HTML and nothing else.
  target.postMessage(
    html === undefined
      ? { type: "covel:connect" }
      : { type: "covel:connect", document: pluginFrameDocument(html) },
    "*",
    [channel.port2],
  );
  port.postMessage({ type: "state", value: host().state });
  return {
    pushState: (state) => port.postMessage({ type: "state", value: state }),
    pushStream: (seq, append) => {
      if (Number.isSafeInteger(seq) && seq > 0 && append)
        port.postMessage({ type: "stream", seq, append });
    },
    close: () => port.close(),
  };
}
