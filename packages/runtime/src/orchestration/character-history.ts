import { z } from "zod";
import {
  ToolError,
  storySegmentSchema,
  type CharacterHistory,
  type WorldModelView,
} from "@covel/shared";
import type { DataStore } from "@covel/store";
import { renderStorySegments } from "../agent-loop/story-output.js";

const storyMetadata = z.object({
  kind: z.literal("story"),
  presentCharacterIds: z.array(z.string().min(1)),
  segments: z
    .array(storySegmentSchema.extend({ speakerId: z.string().optional() }))
    .min(1)
    .max(60),
});
export type CharacterHistorySnapshot = NonNullable<
  import("@covel/shared").DelegationSnapshot["historySnapshot"]
>;

/** One lazy, shared snapshot of committed display messages per execution. */
export class CharacterHistoryReader {
  private loading?: Promise<CharacterHistorySnapshot>;
  private saved?: CharacterHistorySnapshot;
  constructor(
    private readonly store: Pick<DataStore, "listMessagesPage"> | undefined,
    private readonly sessionId: string,
    snapshot?: CharacterHistorySnapshot,
  ) {
    this.saved = snapshot && structuredClone(snapshot);
  }
  snapshot(): CharacterHistorySnapshot | undefined {
    return this.saved && structuredClone(this.saved);
  }
  async freeze(): Promise<void> {
    await this.load();
  }
  private load(): Promise<CharacterHistorySnapshot> {
    if (this.saved) return Promise.resolve(this.saved);
    return (this.loading ??= (async () => {
      if (!this.store)
        throw new ToolError(
          "unavailable",
          "Story history is unavailable in this host",
        );
      const rows = await this.store.listMessagesPage(this.sessionId, {
        limit: 200,
      });
      const messages = rows.flatMap((row) => {
        if (row.sessionId !== this.sessionId || row.role !== "assistant")
          return [];
        const metadata = storyMetadata.safeParse(row.metadata);
        if (!metadata.success) return [];
        return [
          {
            presentCharacterIds: metadata.data.presentCharacterIds,
            segments: metadata.data.segments.map(({ kind, speaker, text }) => ({
              kind,
              ...(speaker !== undefined ? { speaker } : {}),
              text,
            })),
          },
        ];
      });
      return (this.saved = { messages, truncated: rows.length >= 200 });
    })());
  }
  async read(
    characterId: string,
    world: Pick<WorldModelView, "characters"> | undefined,
    options?: { readonly limit?: number },
  ): Promise<CharacterHistory> {
    const parsed = z
      .strictObject({ limit: z.number().int().min(1).max(50).optional() })
      .safeParse(options ?? {});
    if (!parsed.success)
      throw new ToolError(
        "invalid-input",
        "History limit must be an integer from 1 to 50",
      );
    if (!world?.characters.some((character) => character.id === characterId))
      throw new ToolError(
        "not-found",
        "The character is not in the current world view",
      );
    const snapshot = await this.load();
    const matching = snapshot.messages.filter((message) =>
      message.presentCharacterIds.includes(characterId),
    );
    const limit = parsed.data.limit ?? 20;
    let truncated = snapshot.truncated || matching.length > limit;
    let remaining = 16_000;
    const messages: CharacterHistory["messages"] = [];
    for (const message of matching.slice(-limit).reverse()) {
      const content = renderStorySegments(message.segments);
      if (content.length <= remaining) {
        messages.unshift({
          role: "assistant",
          content,
          segments: structuredClone(message.segments),
        });
        remaining -= content.length;
      } else {
        truncated = true;
        if (messages.length === 0) {
          const segments: typeof message.segments = [];
          for (const segment of [...message.segments].reverse()) {
            const size = segment.text.length + (segments.length ? 2 : 0);
            if (size > remaining) continue;
            segments.unshift(structuredClone(segment));
            remaining -= size;
          }
          if (segments.length)
            messages.unshift({
              role: "assistant",
              content: renderStorySegments(segments),
              segments,
            });
        }
        break;
      }
    }
    return { messages, truncated };
  }
}
