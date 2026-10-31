import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chooseActors } from "../lib/policies.js";
import { context, input } from "./fixture.js";
const action = (actors, extra = {}) => ({
  kind: "turn-policy/choose-actors",
  source: "player",
  fields: { actors },
  ...extra,
});
const call = (actions) =>
  chooseActors(
    input({ actions }),
    context({ strategy: "manual" }),
    "turn-policy",
  );
describe("manual selection", () => {
  it("uses a strict flat string schema and concatenates selections in submitted order", async () => {
    const schema = JSON.parse(
      readFileSync(
        new URL("../schemas/choose-actors.schema.json", import.meta.url),
      ),
    );
    expect(schema).toMatchObject({
      additionalProperties: false,
      required: ["actors"],
      properties: { actors: { type: "string" } },
    });
    const plan = await call([
      action(" Keeper \n\nCaptain", { text: "Answer briefly." }),
      action("Mara\nPresident"),
    ]);
    expect(plan.actors).toEqual([
      { characterId: "ivo", instruction: "Answer briefly." },
      { characterId: "mara", instruction: "Answer briefly." },
      { characterId: "president" },
    ]);
    expect(plan.yieldHint).toBe("user");
  });
  it.each([
    "",
    " \n ",
    "Unknown",
    "Absent",
    "mara",
    "x".repeat(81),
    Array(33).fill("Mara").join("\n"),
  ])("rejects an invalid batch before dispatch: %s", async (actors) => {
    await expect(
      call([
        action(`Ivo\n${actors}`),
        ...(actors.trim() ? [] : [action(actors)]),
      ]),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });
  it("rejects additional fields and aggregate overflow, and never replays on advance", async () => {
    await expect(
      call([action("Ivo", { fields: { actors: "Ivo", extra: true } })]),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      call([
        action(Array(20).fill("Ivo").join("\n")),
        action(Array(20).fill("Mara").join("\n")),
      ]),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await call([action("Ivo")]);
    expect(
      (await call([{ kind: "advance", source: "system" }])).actors,
    ).toEqual([]);
  });
});
