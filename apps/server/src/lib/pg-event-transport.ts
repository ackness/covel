/**
 * PG LISTEN/NOTIFY EventBus transport (audit R-02).
 *
 * Multi-pod PG deployments need events emitted on one pod to reach SSE
 * subscribers on other pods. LISTEN/NOTIFY is the lowest-dependency shared
 * transport available: the deployment already runs on PostgreSQL and
 * `postgres` (postgres.js) is already a server dependency for advisory locks.
 *
 * Payloads are opaque frames produced by `@covel/events` — the bus keeps them
 * under PG's 8000-byte NOTIFY limit (oversize events travel as store refs).
 * postgres.js maintains its own dedicated connection for LISTEN, so `max: 1`
 * covers the NOTIFY sends without inflating PG connection usage.
 *
 * Ordering (re-review H-07): the bus publishes each session's frames through
 * a serialized outbox and every frame carries the origin seq, so this
 * transport only needs best-effort ordering — `max: 1` sends NOTIFYs in call
 * order and PG delivers them in commit order; the bus's receive side
 * order-buffers by seq as the safety net for any other transport.
 */

import type { EventBusTransport } from "@covel/events";

const CHANNEL = "covel_event_bus";

export interface PgEventTransport extends EventBusTransport {
  /** Close the underlying PG connections (graceful shutdown). */
  close(): Promise<void>;
}

export async function createPgEventTransport(
  databaseUrl: string,
): Promise<PgEventTransport> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(databaseUrl, { max: 1 });
  const handlers = new Set<(payload: string) => void>();

  await sql.listen(CHANNEL, (payload) => {
    for (const handler of handlers) {
      try {
        handler(payload);
      } catch (err) {
        console.error("[pg-event-transport] handler error:", err);
      }
    }
  });

  return {
    publish(payload: string): Promise<void> {
      // Propagate NOTIFY failures so EventBus's serialized outbox observes and
      // reports a failed frame instead of treating a transport hole as sent.
      return sql.notify(CHANNEL, payload).then(() => undefined);
    },
    subscribe(handler: (payload: string) => void): void {
      handlers.add(handler);
    },
    async close(): Promise<void> {
      await sql.end();
    },
  };
}
