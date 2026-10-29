export const SESSION_BRIDGE_STREAM_INTERVAL_MS = 100;
export type StreamFeedChange = "reset";
export interface StreamFeed {
  subscribe(listener: (change?: StreamFeedChange) => void): () => void;
  read(): { seq: number; text: string } | null;
  onBaseline?(seq: number, length: number): void;
}

/** The append lane; full state pushes establish its baseline. */
export function createStreamPump<Timer>({
  read,
  send,
  resync,
  intervalMs,
  setTimer,
  clearTimer,
}: {
  read: StreamFeed["read"];
  send: (message: { seq: number; append: string }) => void;
  resync: () => void;
  intervalMs: number;
  setTimer: (callback: () => void, delay: number) => Timer;
  clearTimer: (timer: Timer) => void;
}) {
  let timer: Timer | undefined;
  let disposed = false;
  let seq = 0;
  let sentLength = 0;
  let baselineInvalid = false;
  let latest: ReturnType<StreamFeed["read"]> = null;
  const cancel = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
  const deliver = (value: ReturnType<StreamFeed["read"]>) => {
    if (!value) return;
    if (
      baselineInvalid ||
      seq !== value.seq ||
      value.text.length < sentLength
    ) {
      baselineInvalid = false;
      seq = value.seq;
      sentLength = value.text.length;
      resync();
      return;
    }
    const append = value.text.slice(sentLength);
    sentLength = value.text.length;
    if (append) send({ seq: value.seq, append });
  };
  const flush = () => {
    if (disposed) return;
    cancel();
    const value = read();
    if (!value) {
      // Keep the last observed text until turn end, even if the feed has
      // already removed its placeholder before the timer gets to run.
      const hadStream = seq !== 0 || latest !== null;
      if (
        !baselineInvalid &&
        latest?.seq === seq &&
        latest.text.length >= sentLength
      )
        deliver(latest);
      latest = null;
      baselineInvalid = false;
      seq = 0;
      sentLength = 0;
      if (hadStream) resync();
    } else {
      latest = value;
      deliver(value);
    }
  };
  return {
    notify(change?: StreamFeedChange) {
      if (disposed) return;
      if (change === "reset") baselineInvalid = true;
      const value = read();
      if (!value) {
        flush();
        return;
      }
      latest = value;
      if (timer === undefined) timer = setTimer(flush, intervalMs);
    },
    baseline(nextSeq: number, length: number) {
      seq = nextSeq;
      sentLength = length;
      baselineInvalid = false;
      latest = read();
    },
    flush,
    dispose() {
      disposed = true;
      cancel();
      latest = null;
    },
  };
}
