/**
 * Sends events in the order they were pushed. A producer that reports
 * synchronously does not wait for the stream; `settled` resolves when every
 * pushed event is written, and rejects when the client is gone.
 */
export function orderedSend<T>(send: (event: T) => Promise<void>) {
  let pending = Promise.resolve();
  return {
    push(event: T) {
      pending = pending.then(() => send(event));
      // The failure is seen by `settled`; this keeps it from being unhandled.
      pending.catch(() => undefined);
    },
    settled: () => pending,
  };
}
