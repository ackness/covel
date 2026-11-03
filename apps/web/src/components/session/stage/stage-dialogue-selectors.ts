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

/** One page of the stage reader: a story segment or a prose paragraph. */
export interface StoryReaderUnit {
  readonly text: string;
  /** The nameplate; absent for narration and unattributed lines. */
  readonly speaker?: string;
  /** The speaking character, when the name resolved to one. */
  readonly speakerId?: string;
  readonly narration: boolean;
}

/**
 * The pages of a committed story. A structured story (its text is its
 * segments joined by blank lines) pages by segment and keeps each speaker;
 * any other story pages by paragraph.
 */
export function storyReaderUnits(
  message: Pick<StreamMessage, "content" | "segments">,
): StoryReaderUnit[] {
  const segments = message.segments;
  if (
    segments?.length &&
    segments.map((segment) => segment.text).join("\n\n") === message.content
  )
    return segments.map((segment) => {
      const named = segment.kind !== "narration" && !!segment.speaker;
      return {
        text: segment.text,
        narration: !named,
        ...(named ? { speaker: segment.speaker } : {}),
        ...(named && segment.speakerId ? { speakerId: segment.speakerId } : {}),
      };
    });
  return message.content
    .split(/\n\s*\n/)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({ text, narration: true }));
}

/** Reading time for auto-play: longer lines stay up longer, within bounds. */
export function readerPageDelayMs(text: string): number {
  return Math.min(9000, Math.max(1800, 1000 + [...text].length * 60));
}
