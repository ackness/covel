import { z } from "zod";
import type { PresenceRecord } from "@/lib/character-visuals.js";
import type { DomainEventPreview } from "@/stores/domain-event-preview-store.js";
import type { StageSpeaker } from "./stage-direction-selectors.js";

const paragraphSpeakersSchema = z
  .array(z.string().min(1).max(128).nullable())
  .min(1)
  .max(80);
const dialogueRecordSchema = z.object({
  schemaVersion: z.literal(1),
  turnId: z.string().min(1),
  paragraphSpeakers: z
    .array(
      z
        .object({
          characterId: z.string().min(1),
          displayName: z.string().min(1),
        })
        .nullable(),
    )
    .min(1)
    .max(80),
});

/** The speaker contract and the typewriter must use identical boundaries. */
export function splitStageParagraphs(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n\n");
}

/** Explicit per-turn identities only: actor focus never attributes prose. */
export function resolveStageParagraphSpeakers({
  turnId,
  record,
  preview,
  speakers,
  presence,
  isStreaming,
}: {
  readonly turnId?: string;
  readonly record: unknown;
  readonly preview?: DomainEventPreview;
  readonly speakers: readonly StageSpeaker[];
  readonly presence: Readonly<Record<string, PresenceRecord | undefined>>;
  readonly isStreaming: boolean;
}): readonly (string | null)[] | undefined {
  if (!turnId) return undefined;
  if (preview?.turnId === turnId) {
    const parsed = z
      .object({ paragraphSpeakers: paragraphSpeakersSchema })
      .safeParse(preview.data.dialogue);
    if (!parsed.success) return undefined;
    return parsed.data.paragraphSpeakers.map((id) => {
      if (id === null) return null;
      const speaker = speakers.find((candidate) => candidate.id === id);
      if (speaker) return speaker.name;
      const candidate = Object.values(presence).find(
        (row) => row?.characterId === id,
      );
      return typeof candidate?.displayName === "string"
        ? candidate.displayName
        : null;
    });
  }
  // A retry can stream under the same turn id; its previous committed mapping
  // must not label a newly generated response before this attempt emits cues.
  if (isStreaming) return undefined;
  const parsed = dialogueRecordSchema.safeParse(record);
  if (!parsed.success || parsed.data.turnId !== turnId) return undefined;
  return parsed.data.paragraphSpeakers.map(
    (speaker) => speaker?.displayName ?? null,
  );
}

export function stageParagraphSpeakerName(
  paragraphSpeakers: readonly (string | null)[] | undefined,
  text: string,
  paragraphIndex: number,
  streamEnded: boolean,
): string | undefined {
  if (!paragraphSpeakers) return undefined;
  const count = splitStageParagraphs(text).length;
  if (
    count > paragraphSpeakers.length ||
    (streamEnded && count !== paragraphSpeakers.length)
  ) {
    return undefined;
  }
  return paragraphSpeakers[paragraphIndex] ?? undefined;
}
