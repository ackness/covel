import { describe, expect, it } from "vitest";
import {
  collectCharacterVisualRefs,
  replaceDefaultCharacterVisual,
  resolveCharacterVisual,
  type PresenceRecord,
} from "../character-visuals.js";

const ref = (id: string) => ({ id, mime: "image/png", size: 100 });

const presence: PresenceRecord = {
  characterId: "npc-rin",
  sprite: ref("legacy"),
  visuals: {
    defaultVariant: "uniform-neutral",
    variants: [
      {
        id: "uniform-neutral",
        outfit: "uniform",
        expression: "neutral",
        pose: "default",
        sprite: ref("uniform-neutral"),
      },
      {
        id: "uniform-smile",
        outfit: "uniform",
        expression: "smile",
        pose: "default",
        sprite: ref("uniform-smile"),
        stage: { scale: 1.05, offsetX: -2 },
      },
      {
        id: "uniform-smile-wave",
        outfit: "uniform",
        expression: "smile",
        pose: "wave",
        sprite: ref("uniform-smile-wave"),
      },
      {
        id: "summer-neutral",
        outfit: "summer",
        expression: "neutral",
        pose: "default",
        sprite: ref("summer-neutral"),
      },
    ],
  },
};

describe("resolveCharacterVisual", () => {
  it("uses the catalog default when no visual is requested", () => {
    expect(resolveCharacterVisual(presence)).toMatchObject({
      ref: ref("uniform-neutral"),
      variantId: "uniform-neutral",
    });
  });

  it("resolves exact variant ids before semantic fields", () => {
    expect(
      resolveCharacterVisual(presence, {
        variantId: "summer-neutral",
        outfit: "uniform",
      }),
    ).toMatchObject({
      ref: ref("summer-neutral"),
      variantId: "summer-neutral",
    });
  });

  it("resolves outfit, expression and pose exactly", () => {
    expect(
      resolveCharacterVisual(presence, {
        outfit: "uniform",
        expression: "smile",
        pose: "wave",
      }),
    ).toMatchObject({
      ref: ref("uniform-smile-wave"),
      variantId: "uniform-smile-wave",
    });
  });

  it("inherits the catalog default outfit for expression-only cues", () => {
    expect(
      resolveCharacterVisual(presence, { expression: "smile" }),
    ).toMatchObject({
      ref: ref("uniform-smile"),
      variantId: "uniform-smile",
    });
  });

  it("falls back through default pose, neutral expression and catalog default", () => {
    expect(
      resolveCharacterVisual(presence, {
        outfit: "uniform",
        expression: "smile",
        pose: "missing",
      }),
    ).toMatchObject({ ref: ref("uniform-smile") });

    expect(
      resolveCharacterVisual(presence, {
        outfit: "summer",
        expression: "missing",
      }),
    ).toMatchObject({ ref: ref("summer-neutral") });

    expect(
      resolveCharacterVisual(presence, {
        outfit: "missing",
        expression: "missing",
      }),
    ).toMatchObject({ ref: ref("uniform-neutral") });
  });

  it("keeps legacy sprite/avatar records working", () => {
    expect(resolveCharacterVisual({ sprite: ref("sprite") })).toEqual({
      ref: ref("sprite"),
    });
    expect(resolveCharacterVisual({ avatar: ref("avatar") })).toEqual({
      ref: ref("avatar"),
    });
  });

  it("returns the selected variant framing", () => {
    expect(
      resolveCharacterVisual(presence, {
        outfit: "uniform",
        expression: "smile",
      }),
    ).toMatchObject({ stage: { scale: 1.05, offsetX: -2 } });
  });
});

describe("collectCharacterVisualRefs", () => {
  it("deduplicates legacy and variant refs", () => {
    const duplicate = ref("same");
    expect(
      collectCharacterVisualRefs({
        sprite: duplicate,
        avatar: duplicate,
        visuals: {
          variants: [{ id: "default", sprite: duplicate }],
        },
      }),
    ).toEqual([duplicate]);
  });
});

describe("replaceDefaultCharacterVisual", () => {
  it("updates the declared default and preserves named variants", () => {
    const replacement = ref("replacement");
    const presence: PresenceRecord = {
      visuals: {
        defaultVariant: "uniform-neutral",
        variants: [
          {
            id: "uniform-neutral",
            outfit: "uniform",
            expression: "neutral",
            sprite: ref("old-default"),
          },
          {
            id: "summer-smile",
            outfit: "summer",
            expression: "smile",
            sprite: ref("summer"),
          },
        ],
      },
    };

    expect(replaceDefaultCharacterVisual(presence, replacement)).toEqual({
      defaultVariant: "uniform-neutral",
      variants: [
        {
          id: "uniform-neutral",
          outfit: "uniform",
          expression: "neutral",
          sprite: replacement,
        },
        {
          id: "summer-smile",
          outfit: "summer",
          expression: "smile",
          sprite: ref("summer"),
        },
      ],
    });
  });

  it("creates a default catalog for a legacy presence record", () => {
    const replacement = ref("replacement");
    expect(replaceDefaultCharacterVisual({}, replacement)).toEqual({
      defaultVariant: "default",
      variants: [
        {
          id: "default",
          outfit: "default",
          expression: "neutral",
          pose: "default",
          sprite: replacement,
        },
      ],
    });
  });
});
