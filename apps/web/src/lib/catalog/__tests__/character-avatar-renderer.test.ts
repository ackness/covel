import { describe, expect, it } from "vitest";
import { resolveCharacterAvatar } from "../character-avatar-renderer.js";

const AVATAR = { id: "a".repeat(64), mime: "image/png", size: 100 };
const records = {
  "npc-lin-yuanzhou": {
    characterId: "npc-lin-yuanzhou",
    displayName: "林远舟",
    avatar: AVATAR,
  },
  "npc-su-yao": { characterId: "npc-su-yao", displayName: "苏窈" }, // no avatar
};

describe("resolveCharacterAvatar", () => {
  it("matches by exact characterId", () => {
    expect(
      resolveCharacterAvatar(
        records,
        "npc-lin-yuanzhou",
        "characterId",
        "avatar",
      ),
    ).toEqual(AVATAR);
  });

  it("matches when the character-list id carries a session prefix", () => {
    expect(
      resolveCharacterAvatar(
        records,
        "mistport-04ef0d64-npc-lin-yuanzhou",
        "characterId",
        "avatar",
      ),
    ).toEqual(AVATAR);
  });

  it("returns null when the matched record has no avatar (presence without a portrait)", () => {
    expect(
      resolveCharacterAvatar(records, "npc-su-yao", "characterId", "avatar"),
    ).toBeNull();
  });

  it("returns null when no character matches", () => {
    expect(
      resolveCharacterAvatar(records, "npc-unknown", "characterId", "avatar"),
    ).toBeNull();
  });

  it("returns null for an empty presence namespace (world without portraits)", () => {
    expect(
      resolveCharacterAvatar({}, "npc-lin-yuanzhou", "characterId", "avatar"),
    ).toBeNull();
  });

  it("returns null when characterId is missing", () => {
    expect(
      resolveCharacterAvatar(records, undefined, "characterId", "avatar"),
    ).toBeNull();
  });

  it("does not false-match across a different '-meg' suffix", () => {
    const r = { "npc-meg": { characterId: "npc-meg", avatar: AVATAR } };
    // a char id ending in `-npc-iron-meg` must not borrow `npc-meg`'s avatar
    expect(
      resolveCharacterAvatar(r, "sess-npc-iron-meg", "characterId", "avatar"),
    ).toBeNull();
  });
});
