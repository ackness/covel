/**
 * A picture shown earlier in a session reaches the model that writes the
 * story: as a note in the history for every model, and as the image itself
 * for a model that accepts image input.
 *
 * The picture enters the store the way a real one does, through the commit
 * of an `asset.generate` proposal, and the assertions read the request the
 * LLM adapter receives.
 */

import { describe, expect, it } from "vitest";
import type { Proposal, RuntimeManifest, TurnInput } from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import { createMemoryMediaStore, createMemoryStore } from "@covel/store/memory";
import { createCommitPipeline } from "../src/session/session-kernel.js";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { LLMAdapter, LLMResponse } from "../src/llm/llm-adapter.js";
import { MAX_PICTURE_BYTES } from "../src/agent-loop/picture-attachments.js";
import { buildLlmCallingPayload } from "../src/llm/llm-trace-payload.js";

const SESSION_ID = "sess-pictures";
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

type Call = Parameters<LLMAdapter["generate"]>[0];
type Message = Call["messages"][number];

class RecordingLLM implements LLMAdapter {
  readonly calls: Call[] = [];
  acceptsImageInput?: LLMAdapter["acceptsImageInput"];
  constructor(vision: boolean) {
    if (vision) this.acceptsImageInput = () => true;
  }
  async generate(params: Call): Promise<LLMResponse> {
    this.calls.push(params);
    return {
      content: "The story goes on.",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

const narrator: RuntimeManifest = {
  name: "test-narrator",
  pluginId: "test-narrator",
  description: "Synthetic narrator.",
  stage: "narrative",
  runtimeType: "agent",
  outputKind: "story",
};

const loaded = (manifest: RuntimeManifest): LoadedRuntime => ({
  manifest,
  promptTemplate: "You narrate.",
});

const turnInput = (turnId: string, playerMessage: string): TurnInput => ({
  origin: "player",
  sessionId: SESSION_ID,
  turnId,
  playerMessage,
});

function pngBytes(seed: number, length = 64): Uint8Array {
  const bytes = new Uint8Array(length).fill(seed);
  bytes.set(PNG_HEAD);
  return bytes;
}

async function makeSession() {
  const store = createMemoryStore();
  const mediaStore = createMemoryMediaStore();
  const pipeline = createCommitPipeline(store);
  let clock = 0;
  const at = () => `2026-01-01T00:00:${String(clock++).padStart(2, "0")}Z`;

  const say = (turnId: string, role: "user" | "assistant", content: string) =>
    store.appendTurnMessage({
      id: crypto.randomUUID(),
      sessionId: SESSION_ID,
      turnId,
      sourceType: role === "user" ? "player" : "runtime",
      ...(role === "assistant" ? { sourceRuntimeId: narrator.name } : {}),
      role,
      content,
      order: role === "user" ? 0 : 2,
      createdAt: at(),
    });

  /** Stores a picture and commits it as the image plugin's background job does. */
  const showPicture = async (
    prompt: string,
    bytes: Uint8Array,
    owner = SESSION_ID,
  ) => {
    const ref = await mediaStore.put(bytes, "image/png");
    await mediaStore.recordOwnership(ref.id, owner, "image-plugin");
    const proposal: Proposal = {
      id: crypto.randomUUID(),
      type: "asset.generate",
      source: { pluginId: "image-plugin", runtimeId: "image-plugin/generate" },
      turnId: `job-${clock}`,
      sessionId: SESSION_ID,
      payload: { ref, modality: "image", meta: { prompt } },
      timestamp: at(),
    };
    expect((await pipeline.commit(proposal)).committed).toBe(true);
    return ref;
  };

  const play = async (llm: RecordingLLM, manifest = narrator) => {
    const result = await executeTurn(
      turnInput(`turn-${clock}`, "What do I see?"),
      [manifest],
      { loadRuntime: async () => loaded(manifest), llm, store, mediaStore },
    );
    expect(result.runtimeResults[0]?.status).toBe("success");
    return llm.calls.at(-1)!.messages;
  };

  return { store, mediaStore, say, showPicture, play };
}

const text = (message: Message): string =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .map((part) => (part.type === "text" ? part.text : `<${part.type}>`))
        .join("\n");

const images = (messages: readonly Message[]) =>
  messages.flatMap((message) =>
    typeof message.content === "string"
      ? []
      : message.content.filter((part) => part.type === "image"),
  );

describe("pictures in the story history", () => {
  it("tells a text-only model what the picture shows, with no asset bookkeeping", async () => {
    const session = await makeSession();
    await session.say("t1", "user", "I walk to the harbour.");
    await session.say("t1", "assistant", "Gulls wheel over the quay.");
    const ref = await session.showPicture(
      "a red lighthouse on a black rock",
      pngBytes(1),
    );

    const messages = await session.play(new RecordingLLM(false));

    const note = messages.find((message) =>
      text(message).includes("a red lighthouse on a black rock"),
    );
    expect(note).toMatchObject({
      role: "user",
      content:
        "A picture was shown to the player here. It depicts: a red lighthouse on a black rock",
    });
    // The note follows the turn it appeared after, before the new player message.
    const order = messages.map(text);
    expect(order.indexOf("Gulls wheel over the quay.")).toBeLessThan(
      messages.indexOf(note!),
    );
    expect(messages.indexOf(note!)).toBeLessThan(
      order.findIndex((entry) => entry.includes("What do I see?")),
    );
    // Text only: no content part of any kind, and nothing that names the asset.
    expect(messages.every((m) => typeof m.content === "string")).toBe(true);
    expect(JSON.stringify(messages)).not.toContain(ref.id);
  });

  it("sends the two newest pictures to a model that reads images and leaves the history as it was", async () => {
    const session = await makeSession();
    await session.say("t1", "user", "I walk to the harbour.");
    await session.say("t1", "assistant", "Gulls wheel over the quay.");
    await session.showPicture("first picture", pngBytes(1));
    await session.showPicture("second picture", pngBytes(2));

    const textOnly = await session.play(new RecordingLLM(false));
    const withImages = await session.play(new RecordingLLM(true));

    const sent = images(withImages);
    expect(sent).toEqual([
      {
        type: "image",
        image: Buffer.from(pngBytes(1)).toString("base64"),
        mediaType: "image/png",
      },
      {
        type: "image",
        image: Buffer.from(pngBytes(2)).toString("base64"),
        mediaType: "image/png",
      },
    ]);
    // One message carries them, at the start of the current turn.
    const carrier = withImages.findIndex((m) => typeof m.content !== "string");
    expect(text(withImages[carrier]!)).toContain("Picture 2: second picture");
    expect(text(withImages[carrier + 1]!)).toContain("What do I see?");

    // A third picture moves the first out of the newest two. Everything that
    // was in the request before the carrier is still there, unchanged: the
    // provider's prefix cache is not broken by pictures aging out.
    await session.showPicture("third picture", pngBytes(3));
    const later = await session.play(new RecordingLLM(true));
    expect(images(later).map((part) => part.image)).toEqual([
      Buffer.from(pngBytes(2)).toString("base64"),
      Buffer.from(pngBytes(3)).toString("base64"),
    ]);
    const before = withImages.slice(0, carrier).map(text);
    expect(later.slice(0, before.length).map(text)).toEqual(before);
    // The first picture is still in the history as its note.
    expect(later.map(text).join("\n")).toContain("It depicts: first picture");
    // The text-only request is the same conversation without the carrier.
    expect(textOnly.map(text)).toEqual(
      withImages
        .filter((_, index) => index !== carrier)
        .slice(0, textOnly.length)
        .map(text),
    );
  });

  it("does not send a picture the session may not read, or one over the size limit", async () => {
    const session = await makeSession();
    await session.say("t1", "user", "I walk to the harbour.");
    // Stored for another session: the proposal names it, the session has no claim.
    await session.showPicture("someone else's", pngBytes(4), "other-session");
    await session.showPicture("huge", pngBytes(5, MAX_PICTURE_BYTES + 1));

    const messages = await session.play(new RecordingLLM(true));

    expect(images(messages)).toEqual([]);
    expect(messages.every((m) => typeof m.content === "string")).toBe(true);
    // The notes stay: they are text the player-facing transcript already shows.
    expect(messages.map(text).join("\n")).toContain("It depicts: huge");
  });

  it("shows pictures to the story runtime only", async () => {
    const session = await makeSession();
    await session.say("t1", "user", "I walk to the harbour.");
    await session.showPicture("a map", pngBytes(6));
    const bookkeeper: RuntimeManifest = {
      ...narrator,
      name: "test-tracker",
      pluginId: "test-tracker",
      stage: "post-turn",
      outputKind: "plugin",
    };

    const messages = await session.play(new RecordingLLM(true), bookkeeper);

    expect(images(messages)).toEqual([]);
    expect(messages.map(text).join("\n")).toContain("It depicts: a map");
  });

  it("writes no conversation row for an asset that is not a picture", async () => {
    const session = await makeSession();
    const ref = await session.mediaStore.put(pngBytes(7), "audio/wav");
    const result = await createCommitPipeline(session.store).commit({
      id: crypto.randomUUID(),
      type: "asset.generate",
      source: { pluginId: "tts", runtimeId: "tts/speak" },
      turnId: "job",
      sessionId: SESSION_ID,
      payload: { ref, modality: "audio", meta: { prompt: "a line" } },
      timestamp: "2026-01-01T00:00:00Z",
    });
    expect(result.committed).toBe(true);
    expect(await session.store.listTurnMessages(SESSION_ID)).toEqual([]);
  });

  it("keeps image bytes out of the llm.calling trace", () => {
    const image = "A".repeat(50_000);
    const payload = buildLlmCallingPayload({
      runtimeId: "r",
      pluginId: "p",
      slot: "story",
      model: "m",
      provider: "local",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Picture 1: a map" },
            { type: "image", image, mediaType: "image/png" },
          ],
        },
      ],
      tools: undefined,
      attempt: 1,
      startedAt: "2026-01-01T00:00:00Z",
    });
    expect(JSON.stringify(payload).length).toBeLessThan(1_000);
    expect(JSON.stringify(payload)).toContain(
      "[image data omitted: 50000 base64 characters]",
    );
  });
});
