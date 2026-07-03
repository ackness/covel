import { describe, expect, it } from "vitest";
import { makeManualFunctionContext } from "@covel/plugin-test-utils";
import { getPendingProposals } from "@covel/tools";
import handler from "../handler.js";

function ctx(manualPayload) {
  return makeManualFunctionContext({
    sessionId: "sess-presence",
    turnId: "turn-presence",
    pluginId: "character-presence",
    manualPayload,
  });
}

const avatar = {
  id: "a".repeat(64),
  mime: "image/png",
  size: 1234,
};

describe("character-presence handler", () => {
  it("saves presence refs by character id", async () => {
    const result = await handler(
      ctx({
        presence: {
          schemaVersion: 1,
          characterId: "mentor-lin",
          displayName: "Lin Yue",
          avatar,
          sprite: { id: "b".repeat(64), mime: "image/png", size: 5678 },
          voice: { id: "c".repeat(64), mime: "audio/wav", size: 4321 },
          media: {
            theme: { id: "d".repeat(64), mime: "audio/mpeg", size: 9876 },
          },
        },
      }),
    );

    expect(result).toEqual({
      saved: true,
      characterId: "mentor-lin",
    });

    const proposals = getPendingProposals(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      type: "plugin.data",
      source: {
        pluginId: "character-presence",
        runtimeId: "character-presence",
      },
      sessionId: "sess-presence",
      turnId: "turn-presence",
      payload: {
        namespace: "presence",
        key: "mentor-lin",
        value: {
          schemaVersion: 1,
          characterId: "mentor-lin",
          displayName: "Lin Yue",
          avatar,
        },
      },
    });
    expect(proposals[0].payload.value.updatedAt).toBeTypeOf("string");
  });

  it("accepts presenceJson payloads", async () => {
    const result = await handler(
      ctx({
        presenceJson: JSON.stringify({
          schemaVersion: 1,
          characterId: "npc:archivist-1",
          avatar,
        }),
      }),
    );

    expect(result.characterId).toBe("npc:archivist-1");
    const proposals = getPendingProposals(result);
    expect(proposals[0].payload.key).toBe("npc:archivist-1");
  });

  it("accepts structured presence form payloads", async () => {
    const result = await handler(
      ctx({
        presenceForm: {
          characterId: "mentor-lin",
          displayName: "林月",
          style: "语音轻，立绘偏安静。",
          avatarId: "a".repeat(64),
          avatarMime: "image/png",
          avatarSize: "1234",
          spriteId: "b".repeat(64),
          spriteMime: "image/png",
          spriteSize: "5678",
        },
      }),
    );

    expect(result).toEqual({
      saved: true,
      characterId: "mentor-lin",
    });
    const proposals = getPendingProposals(result);
    expect(proposals[0]).toMatchObject({
      type: "plugin.data",
      payload: {
        namespace: "presence",
        key: "mentor-lin",
        value: {
          schemaVersion: 1,
          characterId: "mentor-lin",
          displayName: "林月",
          style: "语音轻，立绘偏安静。",
          avatar: {
            id: "a".repeat(64),
            mime: "image/png",
            size: 1234,
          },
          sprite: {
            id: "b".repeat(64),
            mime: "image/png",
            size: 5678,
          },
        },
      },
    });
  });

  it("generates short character ids when structured forms leave id blank", async () => {
    const result = await handler(
      ctx({
        presenceForm: {
          displayName: "Transfer Student",
        },
      }),
    );

    expect(result).toEqual({
      saved: true,
      characterId: "npc-transfer-student",
    });
  });

  it("rejects malformed presence payloads", async () => {
    await expect(handler(ctx({ presenceJson: "{bad json" }))).rejects.toThrow(
      "manualPayload.presenceJson must be valid JSON",
    );

    await expect(handler(ctx({ presence: { avatar } }))).rejects.toThrow(
      "presence.characterId must be a non-empty string",
    );

    await expect(
      handler(
        ctx({
          presence: { schemaVersion: 2, characterId: "mentor-lin" },
        }),
      ),
    ).rejects.toThrow("presence.schemaVersion must be 1");

    await expect(
      handler(
        ctx({
          presence: { schemaVersion: 1, characterId: "../escape" },
        }),
      ),
    ).rejects.toThrow("presence.characterId must be 1-128 characters");

    await expect(
      handler(
        ctx({
          presence: {
            schemaVersion: 1,
            characterId: "mentor-lin",
            avatar: { id: "not-sha", mime: "image/png", size: 1 },
          },
        }),
      ),
    ).rejects.toThrow(
      "presence.avatar.id must be a 64-character lowercase sha256 hex string",
    );

    await expect(
      handler(
        ctx({
          presence: {
            schemaVersion: 1,
            characterId: "mentor-lin",
            media: { "../bad": avatar },
          },
        }),
      ),
    ).rejects.toThrow("presence.media keys must be 1-64 safe characters");

    await expect(
      handler(
        ctx({
          presence: {
            schemaVersion: 1,
            characterId: "large-presence",
            metadata: { text: "x".repeat(70_000) },
          },
        }),
      ),
    ).rejects.toThrow("presence is too large");
  });
});
