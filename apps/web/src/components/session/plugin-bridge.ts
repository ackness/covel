import { z } from "zod";
import {
  PLUGIN_FRAME_CSP,
  PLUGIN_BRIDGE_SCRIPT,
  SESSION_BRIDGE_MAX_REQUEST_BYTES,
  SESSION_BRIDGE_REQUEST_BUDGET,
  sessionBridgeOutcomeSchema,
} from "@covel/shared";

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
const actionRequest = z.strictObject({
  type: z.literal("action"),
  id: z.string().min(1).max(80),
  action: z.string().min(1).max(120),
  params: z.record(z.string(), z.unknown()),
});

/** Requests one frame may have in progress; more are dropped unanswered. */
const MAX_IN_FLIGHT = 8;

export type PluginBridgeHandler = (params: Record<string, unknown>) => unknown;

export interface PluginBridgeHost {
  state: Readonly<Record<string, unknown>>;
  locked: boolean;
  /** Session pages validate every outgoing result and own their capability gates. */
  sessionPage?: boolean;
  isCurrent?: () => boolean;
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
  const seen = new Set<string>();
  let closed = false;
  const active = () => !closed && (host().isCurrent?.() ?? true);
  const reply = (message: unknown) => {
    if (active()) port.postMessage(message);
  };
  const failure = (id: string) =>
    reply({ type: "result", id, error: "Plugin UI action failed" });
  port.onmessage = async ({ data }: MessageEvent<unknown>) => {
    if (!active()) return;
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
    if (inFlight.has(id)) {
      failure(id);
      return;
    }
    if (seen.has(id) || seen.size >= SESSION_BRIDGE_REQUEST_BUDGET) {
      failure(id);
      return;
    }
    seen.add(id);
    if (inFlight.size >= MAX_IN_FLIGHT) return;
    inFlight.add(id);
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(data)).length;
      if (bytes > SESSION_BRIDGE_MAX_REQUEST_BYTES)
        throw new Error("Request too large");
      const request = actionRequest.safeParse(data);
      if (!request.success) throw new Error("Invalid plugin UI action");
      const { locked, handlers, sessionPage } = host();
      const handler = Object.hasOwn(handlers, request.data.action)
        ? handlers[request.data.action]
        : undefined;
      if ((!sessionPage && locked) || !handler || !active())
        throw new Error("Plugin UI action is unavailable");
      const value = await handler(request.data.params);
      if (sessionPage) {
        const parsed = sessionBridgeOutcomeSchema.safeParse(value);
        if (!parsed.success) throw new Error("Invalid public outcome");
        reply({ type: "result", id, value: parsed.data });
      } else reply({ type: "result", id, value });
    } catch {
      failure(id);
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
  reply({ type: "state", value: host().state });
  return {
    pushState: (state) => reply({ type: "state", value: state }),
    pushStream: (seq, append) => {
      if (Number.isSafeInteger(seq) && seq > 0 && append)
        reply({ type: "stream", seq, append });
    },
    close: () => {
      if (closed) return;
      port.postMessage({ type: "closed" });
      closed = true;
      port.onmessage = null;
      port.close();
      inFlight.clear();
      seen.clear();
    },
  };
}
