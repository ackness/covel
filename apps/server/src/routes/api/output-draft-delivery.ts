import type { OutputDraftEvent, OutputDraftSink } from "@covel/runtime";

type DraftPayload = OutputDraftEvent["payload"];

/**
 * Takes an event's place in the stream now; `payload` runs when that place
 * is written and returns what to send, or undefined to send nothing.
 */
export type DraftEnqueue = (
  type: OutputDraftEvent["type"],
  payload: () => DraftPayload | undefined,
) => void;

/**
 * Delivers story drafts on the action stream without letting them pile up.
 *
 * A draft event carries the whole draft, so a draft still waiting to be
 * written is replaced by a newer one of the same id: a slow reader gets
 * fewer, later drafts instead of overflowing the queue. A retraction or
 * acceptance drops the waiting draft of its id and keeps its own place; a
 * draft of the same id after it takes a new place behind it.
 */
export function createOutputDraftDelivery(
  enqueue: DraftEnqueue,
): OutputDraftSink {
  const waiting = new Map<string, { payload: DraftPayload; place: symbol }>();
  return (event) => {
    const { draftId } = event.payload;
    if (event.type !== "output.draft") {
      waiting.delete(draftId);
      const payload = event.payload;
      enqueue(event.type, () => payload);
      return;
    }
    const queued = waiting.get(draftId);
    if (queued) {
      queued.payload = event.payload;
      return;
    }
    const place = Symbol(draftId);
    waiting.set(draftId, { payload: event.payload, place });
    enqueue(event.type, () => {
      const latest = waiting.get(draftId);
      // A place given up by a retraction sends nothing, even if a newer
      // draft of the same id is waiting behind that retraction.
      if (latest?.place !== place) return undefined;
      waiting.delete(draftId);
      return latest.payload;
    });
  };
}
