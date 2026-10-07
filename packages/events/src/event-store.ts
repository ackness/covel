/** Plain event record exchanged with the host's persistence adapter. */
export interface EventStoreRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly type: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly targetRuntime?: string;
  readonly turnId?: string;
  readonly createdAt: string;
}

/**
 * Only persistence operations used by the bus. A Covel DataStore satisfies
 * this contract structurally; other hosts need no unrelated database APIs.
 */
export interface EventStore {
  saveEvent(record: EventStoreRecord): Promise<void>;
  /** Trace producers persist before publishing; oversized trace frames reuse that row. */
  getTraceEventById?(
    sessionId: string,
    id: string,
  ): Promise<{
    sessionId: string;
    turnId: string;
    type: string;
    payload: unknown;
    createdAt: string;
  } | null>;
  /** Session-scoped lookup used to receive oversize transport frames. */
  getEventById(sessionId: string, id: string): Promise<EventStoreRecord | null>;
}
