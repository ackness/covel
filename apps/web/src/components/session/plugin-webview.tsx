import { useEffect, useMemo, useRef } from "react";

/** Small transport only; rendering, state interpretation and interactions belong to the plugin. */
const BRIDGE = `
(() => {
  let port, state = {}, sequence = 0;
  const listeners = new Set(), pending = new Map();
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

export function pluginWebviewDocument(html: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'"><script>${BRIDGE}</script>${html}`;
}

export function PluginWebview(props: {
  title: string;
  html: string;
  height?: number;
  state: Readonly<Record<string, unknown>>;
  locked: boolean;
  handlers: Readonly<
    Record<string, (params: Record<string, unknown>) => unknown>
  >;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const port = useRef<MessagePort | null>(null);
  const current = useRef(props);
  current.current = props;
  const document = useMemo(
    () => pluginWebviewDocument(props.html),
    [props.html],
  );
  useEffect(() => {
    port.current?.postMessage({ type: "state", value: props.state });
  }, [props.state]);
  useEffect(
    () => () => {
      port.current?.close();
      port.current = null;
    },
    [],
  );

  const connect = () => {
    port.current?.close();
    const channel = new MessageChannel();
    port.current = channel.port1;
    const inFlight = new Set<string>();
    channel.port1.onmessage = async ({ data }: MessageEvent<unknown>) => {
      if (!data || typeof data !== "object") return;
      const message = data as Record<string, unknown>;
      if (
        message.type !== "action" ||
        typeof message.id !== "string" ||
        message.id.length > 80
      )
        return;
      if (inFlight.has(message.id) || inFlight.size >= 8) return;
      inFlight.add(message.id);
      try {
        const action = typeof message.action === "string" ? message.action : "";
        const handler = Object.hasOwn(current.current.handlers, action)
          ? current.current.handlers[action]
          : undefined;
        if (current.current.locked || !handler)
          throw new Error("Plugin UI action is unavailable");
        if (
          !message.params ||
          typeof message.params !== "object" ||
          Array.isArray(message.params)
        )
          throw new Error("Invalid action parameters");
        const value = await handler(message.params as Record<string, unknown>);
        channel.port1.postMessage({ type: "result", id: message.id, value });
      } catch {
        // Provider errors and credentials must never cross into plugin HTML.
        channel.port1.postMessage({
          type: "result",
          id: message.id,
          error: "Plugin UI action failed",
        });
      } finally {
        inFlight.delete(message.id);
      }
    };
    frame.current?.contentWindow?.postMessage({ type: "covel:connect" }, "*", [
      channel.port2,
    ]);
    channel.port1.postMessage({ type: "state", value: current.current.state });
  };

  return (
    <iframe
      ref={frame}
      title={props.title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={document}
      onLoad={connect}
      className="w-full border-0"
      style={{ height: Math.max(80, Math.min(800, props.height ?? 280)) }}
    />
  );
}
