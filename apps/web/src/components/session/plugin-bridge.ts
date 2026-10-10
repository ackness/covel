import { z } from "zod";
import { PLUGIN_FRAME_CSP } from "@covel/shared";

/** Small transport only; rendering, state interpretation and interactions belong to the plugin. */
const BRIDGE = `
(() => {
  let port, state = {}, sequence = 0;
  const listeners = new Set(), pending = new Map();
  // The host's style scheme, as --covel-* custom properties on the document.
  const applyTheme = theme => {
    if (!theme || !theme.tokens) return;
    const root = document.documentElement;
    for (const [name, value] of Object.entries(theme.tokens))
      root.style.setProperty("--covel-" + name.replace(/[A-Z]/g, c => "-" + c.toLowerCase()), String(value));
    root.style.colorScheme = theme.scheme;
    root.dataset.covelScheme = theme.scheme;
  };
  window.covel = Object.freeze({
    getState: () => state,
    subscribe(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); },
    invoke(action, params = {}) {
      if (!port) return Promise.reject(new Error("Plugin UI is not connected"));
      const id = String(++sequence);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("Plugin UI action timed out")); }, 120000);
        pending.set(id, { resolve, reject, timer });
        port.postMessage({ type: "action", id, action, params });
      });
    }
  });
  addEventListener("message", event => {
    if (event.source !== parent || event.data?.type !== "covel:connect" || !event.ports[0] || port) return;
    port = event.ports[0];
    port.onmessage = ({ data }) => {
      if (data?.type === "state") {
        state = data.value;
        applyTheme(state.theme);
        for (const fn of listeners) fn(state);
      } else if (data?.type === "result") {
        const request = pending.get(data.id);
        if (!request) return;
        pending.delete(data.id); clearTimeout(request.timer);
        data.error ? request.reject(new Error(data.error)) : request.resolve(data.value);
      }
    };
    port.start();
  });
})();`;

/**
 * The plugin's document as the frame host (`public/plugin-frame.html`) loads
 * it: the bridge script, then the plugin's HTML. The frame host's policy is
 * inherited; the copy here keeps the document closed if it is ever rendered
 * somewhere else.
 */
export function pluginFrameDocument(html: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${PLUGIN_FRAME_CSP}"><script>${BRIDGE}</script>${html}`;
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
  html: string,
  host: () => PluginBridgeHost,
): PluginBridge {
  const channel = new MessageChannel();
  const port = channel.port1;
  const inFlight = new Set<string>();
  port.onmessage = async ({ data }: MessageEvent<unknown>) => {
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
    { type: "covel:connect", document: pluginFrameDocument(html) },
    "*",
    [channel.port2],
  );
  port.postMessage({ type: "state", value: host().state });
  return {
    pushState: (state) => port.postMessage({ type: "state", value: state }),
    close: () => port.close(),
  };
}
