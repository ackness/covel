import type { StreamMessage } from "@/stores/session-store/types.js";

/**
 * The nameplate of each paragraph of a committed story: one entry per
 * segment (a story's text is its segments joined by blank lines), `null` for
 * narration and unattributed lines.
 */
export function storyParagraphSpeakers(
  message: Pick<StreamMessage, "segments"> | undefined,
): (string | null)[] | undefined {
  return message?.segments?.map((segment) => segment.speaker ?? null);
}

/**
 * The last attributed segment of a committed story.
 */
export function lastStorySpeaker(
  message: Pick<StreamMessage, "id" | "segments"> | undefined,
): { readonly name: string; readonly characterId?: string } | undefined {
  if (!message) return undefined;
  const segment = message.segments?.findLast((entry) => entry.speaker);
  return segment?.speaker
    ? {
        name: segment.speaker,
        ...(segment.speakerId ? { characterId: segment.speakerId } : {}),
      }
    : undefined;
}
