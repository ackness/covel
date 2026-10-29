import { sessionProjectionSchema } from "./session-bridge.js";
import {
  createStreamPump,
  SESSION_BRIDGE_STREAM_INTERVAL_MS,
  type StreamFeed,
} from "./session-bridge-stream.js";
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
  fill?: boolean;
  stream?: StreamFeed;
  state: Readonly<Record<string, unknown>>;
  locked: boolean;
  handlers: Readonly<Record<string, PluginBridgeHandler>>;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<PluginBridge | null>(null);
  // The widget cannot see the host's stylesheet, so the active style scheme
  // travels with its state and follows theme changes.
  const theme = useThemeSnapshot();
  const state = useMemo<Readonly<Record<string, unknown>>>(
    () => ({ ...props.state, theme }),
    [props.state, theme],
  );
  const current = useRef({ ...props, state });
  current.current = { ...props, state };
  const pump = useRef<ReturnType<
    typeof createStreamPump<ReturnType<typeof setTimeout>>
  > | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);
  const connectedFrame = useRef<HTMLIFrameElement | null>(null);
  const warned = useRef(false);
  const sessionSent = useRef(false);
  const activeFeed = useRef<StreamFeed | undefined>(undefined);
  const fullState = () => {
    const snapshot = current.current.state;
    const feed = current.current.stream;
    if (!feed || !snapshot.session) return snapshot;
    const parsed = sessionProjectionSchema.safeParse({
      ...(snapshot.session as Record<string, unknown>),
      streaming: feed.read(),
    });
    if (parsed.success) return { ...snapshot, session: parsed.data };
    if (!warned.current) {
      warned.current = true;
      console.warn(
        "[session-bridge] Invalid session projection; withholding state",
      );
    }
    const { session: _, ...withoutSession } = snapshot;
    return withoutSession;
  };
  const baseline = (snapshot: Readonly<Record<string, unknown>>) => {
    const value = (
      snapshot.session as
        { streaming?: { seq: number; text: string } } | undefined
    )?.streaming;
    pump.current?.baseline(value?.seq ?? 0, value?.text.length ?? 0);
    current.current.stream?.onBaseline?.(
      value?.seq ?? 0,
      value?.text.length ?? 0,
    );
  };
  const pushFullState = () => {
    if (!bridge.current) return;
    const snapshot = fullState();
    bridge.current.pushState(snapshot);
    sessionSent.current = Boolean(snapshot.session);
    baseline(snapshot);
  };
  const stopStream = () => {
    unsubscribe.current?.();
    unsubscribe.current = null;
    pump.current?.dispose();
    pump.current = null;
    activeFeed.current = undefined;
  };
  const bindStream = () => {
    const feed = current.current.stream;
    if (!bridge.current || activeFeed.current === feed) return;
    stopStream();
    if (!feed) return;
    activeFeed.current = feed;
    pump.current = createStreamPump({
      read: feed.read,
      send: ({ seq, append }) => {
        // A feed cannot send on the append lane without validated session state.
        if (sessionSent.current) bridge.current?.pushStream(seq, append);
      },
      resync: pushFullState,
      intervalMs: SESSION_BRIDGE_STREAM_INTERVAL_MS,
      setTimer: (callback, delay) => setTimeout(callback, delay),
      clearTimer: (timer) => clearTimeout(timer),
    });
    baseline(fullState());
    unsubscribe.current = feed.subscribe(() => pump.current?.notify());
  };
  useEffect(() => {
    bindStream();
    if (current.current.stream?.read() === null) pump.current?.flush();
    pushFullState();
  }, [state, props.stream]);
  useEffect(
    () => () => {
      stopStream();
      bridge.current?.close();
      bridge.current = null;
      sessionSent.current = false;
      connectedFrame.current = null;
    },
    [props.html],
  );

  // One connection per frame element: a later navigation gets no port.
  const connect = () => {
    const target = frame.current?.contentWindow;
    if (!target || connectedFrame.current === frame.current) return;
    connectedFrame.current = frame.current;
    bridge.current?.close();
    const initialState = fullState();
    bridge.current = connectPluginBridge(target, current.current.html, () => ({
      ...current.current,
      state: initialState,
    }));
    sessionSent.current = Boolean(initialState.session);
    bindStream();
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
        height: props.fill
          ? "100%"
          : props.expanded
            ? "min(72vh, 60rem)"
            : Math.max(80, Math.min(800, props.height ?? 280)),
      }}
    />
  );
}
