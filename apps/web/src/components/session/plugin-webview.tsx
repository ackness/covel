import { sessionProjectionSchema } from "./session-bridge.js";
import {
  createStreamPump,
  SESSION_BRIDGE_STREAM_INTERVAL_MS,
  type StreamFeed,
} from "./session-bridge-stream.js";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button.js";
import {
  PLUGIN_FRAME_PATH,
  PLUGIN_PAGE_READY_TIMEOUT_MS,
  PLUGIN_PAGE_HEARTBEAT_INTERVAL_MS,
  PLUGIN_PAGE_MISSED_HEARTBEATS,
} from "@covel/shared";
import { useThemeSnapshot } from "@/theme-system/use-theme-snapshot.js";
import {
  connectPluginBridge,
  type PluginBridge,
  type PluginBridgeHandler,
} from "./plugin-bridge.js";

/**
 * Single-file plugin HTML runs two frames down, both `sandbox="allow-scripts"` and so
 * opaque origins without the app's storage, cookies or API. The outer frame
 * is the static frame host, loaded by URL so that it has a policy of its own
 * (the main page allows no inline script); it puts the plugin's HTML into the
 * inner frame. See `plugin-bridge.ts` for what crosses the boundary.
 */
const FRAME_URL = `${import.meta.env.BASE_URL.replace(/\/$/, "")}${PLUGIN_FRAME_PATH}`;

export function PluginWebview(props: {
  themeSessionId?: string;
  title: string;
  html?: string;
  src?: string;
  onRetry?: () => void;
  /** Retire the page and let the host restore its region. */
  onPageFailure?: () => void;
  height?: number;
  /** Take the room of a large container instead of the declared height. */
  expanded?: boolean;
  fill?: boolean;
  stream?: StreamFeed;
  state: Readonly<Record<string, unknown>>;
  locked: boolean;
  sessionPage?: boolean;
  isCurrent?: () => boolean;
  handlers: Readonly<Record<string, PluginBridgeHandler>>;
}) {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  const [pageStatus, setPageStatus] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  const [updated, setUpdated] = useState(false);
  const pageReady = useRef(false);
  const readyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const src =
    props.src === undefined
      ? FRAME_URL
      : `${import.meta.env.BASE_URL.replace(/\/$/, "")}${props.src}`;
  const frameKey = JSON.stringify([src, props.html, attempt]);
  const owner = useMemo(() => ({ active: true, failed: false }), [frameKey]);
  const heartbeatTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const heartbeat = useRef({ sent: 0, answered: 0 });
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<PluginBridge | null>(null);
  // The widget cannot see the host's stylesheet, so the active style scheme
  // travels with its state and follows theme changes.
  const theme = useThemeSnapshot(props.themeSessionId);
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
  const fullTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const isCurrent = () =>
    owner.active && !owner.failed && (current.current.isCurrent?.() ?? true);
  const fail = () => {
    if (!isCurrent() || owner.failed) return;
    if (current.current.onPageFailure) owner.failed = true;
    clearTimeout(readyTimer.current);
    clearTimeout(heartbeatTimer.current);
    clearTimeout(fullTimer.current);
    stopStream();
    bridge.current?.close();
    bridge.current = null;
    setPageStatus("failed");
    current.current.onPageFailure?.();
  };
  const probe = () => {
    if (
      !isCurrent() ||
      !pageReady.current ||
      document.visibilityState === "hidden"
    )
      return;
    if (
      heartbeat.current.sent - heartbeat.current.answered >=
      PLUGIN_PAGE_MISSED_HEARTBEATS
    ) {
      fail();
      return;
    }
    bridge.current?.ping(++heartbeat.current.sent);
    heartbeatTimer.current = setTimeout(
      probe,
      PLUGIN_PAGE_HEARTBEAT_INTERVAL_MS,
    );
  };
  const startHeartbeat = (grace = PLUGIN_PAGE_HEARTBEAT_INTERVAL_MS) => {
    clearTimeout(heartbeatTimer.current);
    heartbeat.current.answered = heartbeat.current.sent;
    if (current.current.onPageFailure && document.visibilityState !== "hidden")
      heartbeatTimer.current = setTimeout(probe, grace);
  };
  const fullState = () => {
    const snapshot = current.current.state;
    const feed = current.current.stream;
    if (!snapshot.session) {
      if (current.current.sessionPage && current.current.onPageFailure) fail();
      return snapshot;
    }
    if (!feed && !current.current.sessionPage) return snapshot;
    const parsed = sessionProjectionSchema.safeParse({
      ...(snapshot.session as Record<string, unknown>),
      ...(feed ? { streaming: feed.read() } : {}),
    });
    if (parsed.success) return { ...snapshot, session: parsed.data };
    if (!warned.current) {
      warned.current = true;
      console.warn(
        "[session-bridge] Invalid session projection; withholding state",
      );
    }
    if (current.current.sessionPage && current.current.onPageFailure) fail();
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
    if (!bridge.current || !isCurrent()) return;
    const snapshot = fullState();
    if (!isCurrent()) return;
    bridge.current?.pushState(snapshot);
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
        if (isCurrent() && sessionSent.current)
          bridge.current?.pushStream(seq, append);
      },
      resync: pushFullState,
      intervalMs: SESSION_BRIDGE_STREAM_INTERVAL_MS,
      setTimer: (callback, delay) => setTimeout(callback, delay),
      clearTimer: (timer) => clearTimeout(timer),
    });
    baseline(fullState());
    if (!isCurrent()) {
      stopStream();
      return;
    }
    unsubscribe.current = feed.subscribe((change) =>
      pump.current?.notify(change),
    );
  };
  useEffect(() => {
    bindStream();
    if (!bridge.current) return;
    if (!isCurrent()) {
      stopStream();
      bridge.current?.close();
      return;
    }
    if (!current.current.stream?.read()) {
      clearTimeout(fullTimer.current);
      fullTimer.current = undefined;
      pump.current?.flush();
      pushFullState();
    } else if (fullTimer.current === undefined) {
      fullTimer.current = setTimeout(() => {
        fullTimer.current = undefined;
        pushFullState();
      }, SESSION_BRIDGE_STREAM_INTERVAL_MS);
    }
  }, [state, props.stream]);
  useLayoutEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false;
      clearTimeout(heartbeatTimer.current);
      clearTimeout(readyTimer.current);
      clearTimeout(fullTimer.current);
      fullTimer.current = undefined;
      stopStream();
      bridge.current?.close();
      bridge.current = null;
      sessionSent.current = false;
      connectedFrame.current = null;
    };
  }, [owner]);

  useEffect(() => {
    pageReady.current = false;
    setPageStatus("loading");
    setUpdated(false);
    if (props.src === undefined && !props.onPageFailure) return;
    const controller = new AbortController();
    readyTimer.current = setTimeout(() => {
      if (!isCurrent()) return;
      if (
        current.current.onPageFailure &&
        document.visibilityState === "hidden"
      )
        return;
      if (current.current.onPageFailure) {
        fail();
        return;
      }
      setPageStatus("failed");
      // A main-page probe distinguishes an expired digest from other failures.
      void fetch(src, {
        method: "HEAD",
        credentials: "omit",
        signal: controller.signal,
      })
        .then((response) => {
          if (!controller.signal.aborted && !pageReady.current) {
            setUpdated(response.status === 404);
            setPageStatus("failed");
          }
        })
        .catch(() => {
          if (!controller.signal.aborted && !pageReady.current)
            setPageStatus("failed");
        });
    }, PLUGIN_PAGE_READY_TIMEOUT_MS);
    return () => {
      clearTimeout(readyTimer.current);
      controller.abort();
    };
  }, [frameKey, props.src, src]);

  useEffect(() => {
    if (!props.onPageFailure) return;
    const visibility = () => {
      clearTimeout(heartbeatTimer.current);
      clearTimeout(readyTimer.current);
      if (document.visibilityState === "hidden" || !isCurrent()) return;
      if (pageReady.current) startHeartbeat(PLUGIN_PAGE_READY_TIMEOUT_MS);
      else readyTimer.current = setTimeout(fail, PLUGIN_PAGE_READY_TIMEOUT_MS);
    };
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, [owner, props.onPageFailure]);

  // One connection per frame element; navigation retires replacement pages.
  const connect = () => {
    const element = frame.current;
    const target = element?.contentWindow;
    if (!isCurrent() || !target) return;
    if (connectedFrame.current === element) {
      if (current.current.onPageFailure) fail();
      return;
    }
    connectedFrame.current = element;
    bridge.current?.close();
    const initialState = fullState();
    if (!isCurrent()) return;
    bridge.current = connectPluginBridge(
      target,
      props.src === undefined ? current.current.html : undefined,
      () => ({
        ...current.current,
        state: initialState,
        isCurrent,
      }),
      {
        onReady: () => {
          if (
            !isCurrent() ||
            frame.current !== element ||
            connectedFrame.current !== element
          )
            return;
          pageReady.current = true;
          clearTimeout(readyTimer.current);
          setPageStatus("ready");
          startHeartbeat();
        },
        onPageError: () => {
          if (current.current.onPageFailure) fail();
        },
        onPong: (id) => {
          if (isCurrent() && id === heartbeat.current.sent)
            heartbeat.current.answered = id;
        },
      },
    );
    sessionSent.current = Boolean(initialState.session);
    bindStream();
  };

  const iframe = (
    <iframe
      key={frameKey}
      ref={frame}
      title={props.title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src={src}
      onLoad={connect}
      onError={() => {
        if (current.current.onPageFailure) fail();
      }}
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
  if (props.src === undefined) return iframe;
  return (
    <div
      className="relative w-full"
      style={props.fill ? { height: "100%" } : undefined}
      data-page-status={pageStatus}
    >
      {iframe}
      {pageStatus === "failed" && (
        <div
          className="absolute inset-0 z-1 flex flex-col items-center justify-center gap-3 bg-background/95 p-4"
          role="alert"
        >
          <p>{t(updated ? "session.pageUpdated" : "session.pageLoadFailed")}</p>
          <Button
            onClick={() => {
              // Also remount if the refreshed projection has the same digest.
              setAttempt((value) => value + 1);
              props.onRetry?.();
            }}
          >
            {t("session.pageRetry")}
          </Button>
        </div>
      )}
    </div>
  );
}
