import { useEffect, useMemo, useRef } from "react";
import { PLUGIN_FRAME_PATH } from "@covel/shared";
import { useThemeSnapshot } from "@/theme-system/use-theme-snapshot.js";
import {
  connectPluginBridge,
  type PluginBridge,
  type PluginBridgeHandler,
} from "./plugin-bridge.js";

/**
 * Plugin HTML runs two frames down, both `sandbox="allow-scripts"` and so
 * opaque origins without the app's storage, cookies or API. The outer frame
 * is the static frame host, loaded by URL so that it has a policy of its own
 * (the main page allows no inline script); it puts the plugin's HTML into the
 * inner frame. See `plugin-bridge.ts` for what crosses the boundary.
 */
const FRAME_URL = `${import.meta.env.BASE_URL.replace(/\/$/, "")}${PLUGIN_FRAME_PATH}`;

export function PluginWebview(props: {
  title: string;
  html: string;
  height?: number;
  /** Take the room of a large container instead of the declared height. */
  expanded?: boolean;
  state: Readonly<Record<string, unknown>>;
  locked: boolean;
  handlers: Readonly<Record<string, PluginBridgeHandler>>;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<PluginBridge | null>(null);
  // The widget cannot see the host's stylesheet, so the active style scheme
  // travels with its state and follows theme changes.
  const theme = useThemeSnapshot();
  const state = useMemo(
    () => ({ ...props.state, theme }),
    [props.state, theme],
  );
  const current = useRef({ ...props, state });
  current.current = { ...props, state };
  useEffect(() => {
    bridge.current?.pushState(state);
  }, [state]);
  useEffect(
    () => () => {
      bridge.current?.close();
      bridge.current = null;
    },
    [],
  );

  // One connection for each frame element: a document that loads in the
  // frame later gets no port.
  const connectedFrame = useRef<HTMLIFrameElement | null>(null);
  const connect = () => {
    const target = frame.current?.contentWindow;
    if (!target || connectedFrame.current === frame.current) return;
    connectedFrame.current = frame.current;
    bridge.current?.close();
    bridge.current = connectPluginBridge(
      target,
      current.current.html,
      () => current.current,
    );
  };

  return (
    <iframe
      key={props.html}
      ref={frame}
      title={props.title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src={FRAME_URL}
      onLoad={connect}
      className="w-full border-0"
      style={{
        height: props.expanded
          ? "min(72vh, 60rem)"
          : Math.max(80, Math.min(800, props.height ?? 280)),
      }}
    />
  );
}
