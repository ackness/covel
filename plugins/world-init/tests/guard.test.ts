import {
  getToolContent,
  getPendingProposals,
} from "@covel/plugin-handlers-utils";
import { describe, expect, it } from "vitest";
import guard from "../guard.js";
const definition = {
  name: "City wall",
  schema: { type: "integer", minimum: 0, maximum: 100 },
  initialValue: 100,
};
function context(worldRecord, characterSchema = null) {
  return {
    sessionId: "session",
    turnId: "turn",
    pluginId: "world-init",
    runtimeId: "world-init/schema-gen",
    locale: "en-US",
    world: { worldRecord, characterSchema, characters: [], dimensions: {} },
  };
}
describe("world-init schema guard", () => {
  it("reuses the session schema and idempotently adopts declarations, without resetting state", async () => {
    const schema = { version: 2, types: ["enemy"], attributes: [] };
    const result = await guard(
      context({ metadata: { dimensions: { cityWall: definition } } }, schema),
    );
    expect(getToolContent(result)).toMatchObject({
      skip: true,
      preGameDone: true,
      worldSchema: { types: ["enemy"], attributes: [] },
    });
    expect(
      getPendingProposals(result).map((proposal) => proposal.type),
    ).toEqual(["dimension.initialize"]);
  });
  it("does not derive character-owned fields from global dimensions", async () => {
    expect(
      await guard(
        context({ metadata: { dimensions: { cityWall: definition } } }),
      ),
    ).toEqual({ skip: false, initialized: false });
  });
  it("buffers author character schema and dimensions together", async () => {
    const schema = {
      types: ["spirit"],
      attributes: [
        { id: "energy", name: "Energy", type: "number", category: "stats" },
      ],
    };
    const result = await guard(
      context({
        metadata: {
          characterSchema: schema,
          dimensions: { cityWall: definition },
        },
      }),
    );
    expect(getPendingProposals(result)).toMatchObject([
      { type: "character.schema.set", payload: schema },
      {
        type: "dimension.initialize",
        payload: { definitions: { cityWall: definition } },
      },
    ]);
  });
  it("lets the model generate missing character schema", async () => {
    expect(await guard(context({ metadata: {} }))).toEqual({
      skip: false,
      initialized: false,
    });
  });
});
