import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { PLUGIN_BRIDGE_SCRIPT } from "@covel/shared";

it.each([false, true])(
  "captures non-bubbling script load failures (before connection: %s)",
  (beforeConnection) => {
    const listeners: [string, EventListener, boolean | undefined][] = [];
    const image = document.createElement("img");
    const script = document.createElement("script");
    try {
      runInNewContext(PLUGIN_BRIDGE_SCRIPT, {
        window,
        document,
        parent: window.parent,
        addEventListener: (
          type: string,
          listener: EventListener,
          capture?: boolean,
        ) => {
          listeners.push([type, listener, capture]);
          window.addEventListener(type, listener, capture);
        },
      });
      const port = { start: vi.fn(), postMessage: vi.fn() };
      const connect = () =>
        window.dispatchEvent(
          new MessageEvent("message", {
            source: window,
            data: { type: "covel:connect" },
            ports: [port as unknown as MessagePort],
          }),
        );
      if (!beforeConnection) {
        connect();
        expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({
          type: "ready",
        });
        port.postMessage.mockClear();
      }
      document.body.append(image);
      image.dispatchEvent(new Event("error", { bubbles: false }));
      expect(port.postMessage).not.toHaveBeenCalled();
      script.src = "/private-application.js";
      document.body.append(script);
      script.dispatchEvent(new Event("error", { bubbles: false }));
      if (beforeConnection) connect();
      expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({
        type: "page-error",
      });
    } finally {
      for (const [type, listener, capture] of listeners)
        window.removeEventListener(type, listener, capture);
      image.remove();
      script.remove();
      Reflect.deleteProperty(window, "covel");
    }
  },
);
