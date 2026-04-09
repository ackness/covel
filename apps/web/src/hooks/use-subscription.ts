import { useEffect, useRef, useCallback, useState } from "react";
import {
  createSessionSubscription,
  type SessionSubscription,
  type ConnectionState,
  type SubscriptionEventHandler,
} from "@/services/subscription.js";

/**
 * React hook for managing a persistent SSE subscription to session events.
 *
 * Creates a subscription when sessionId is provided, tears it down on
 * unmount or session change. Handles reconnection automatically.
 *
 * Usage:
 *   const { connectionState, on, off } = useSubscription(sessionId, ['runtime', 'state']);
 *   useEffect(() => {
 *     const handler = (event) => console.log(event);
 *     on('runtime', handler);
 *     return () => off('runtime', handler);
 *   }, [on, off]);
 */
export function useSubscription(
  sessionId: string | null,
  topics?: string[],
): {
  connectionState: ConnectionState;
  on: (topic: string, handler: SubscriptionEventHandler) => void;
  off: (topic: string, handler: SubscriptionEventHandler) => void;
} {
  const [connectionState, setConnectionState] = useState<ConnectionState>("closed");
  const subRef = useRef<SessionSubscription | null>(null);

  // Memoize topics join so we can use it as a dependency without causing
  // infinite re-renders from array identity changes.
  const topicsKey = topics?.join(",");

  useEffect(() => {
    if (!sessionId) {
      setConnectionState("closed");
      return;
    }

    const sub = createSessionSubscription(sessionId, {
      topics,
      onStateChange: setConnectionState,
    });
    subRef.current = sub;

    return () => {
      sub.close();
      subRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, topicsKey]);

  const on = useCallback((topic: string, handler: SubscriptionEventHandler) => {
    subRef.current?.on(topic, handler);
  }, []);

  const off = useCallback((topic: string, handler: SubscriptionEventHandler) => {
    subRef.current?.off(topic, handler);
  }, []);

  return { connectionState, on, off };
}
