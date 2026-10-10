import { describe, expect, it } from "vitest";
import { matchScene } from "../lib/scene-match.js";

// The shape of a world's scenes: `locationRef` lists the places a backdrop
// stands for, separated by slashes.
const scenes = [
  {
    sceneId: "classroom",
    name: "教室",
    locationRef: "二年 B 组/靠窗座位/二楼走廊",
  },
  {
    sceneId: "library",
    name: "图书馆",
    locationRef: "图书馆/二楼窗边长桌/旧刊架",
  },
  { sceneId: "seawall", name: "海堤", locationRef: "樱坂海堤/海堤长椅" },
];

const idOf = (location) => matchScene(scenes, location)?.sceneId ?? null;

describe("matchScene", () => {
  it("reads each part of locationRef as a name of the scene", () => {
    expect(idOf("旧刊架")).toBe("library");
    expect(idOf("二年B组")).toBe("classroom");
    // The old rule compared the whole "a/b/c" string: "桌/旧" was inside it.
    expect(idOf("桌/旧")).toBeNull();
  });

  it("shows the scene whose name is inside a longer location, the longest name first", () => {
    expect(idOf("图书馆的角落")).toBe("library");
    // "海堤" is inside it too, and "樱坂海堤" is the longer name of the same scene.
    expect(idOf("傍晚的樱坂海堤")).toBe("seawall");
    expect(idOf("图书馆二楼窗边长桌旁")).toBe("library");
  });

  it("shows a scene for a fragment of one of its names only when no other scene shares it", () => {
    expect(idOf("樱坂")).toBe("seawall");
    // Both the classroom and the library have a name with "二楼" in it.
    expect(idOf("二楼")).toBeNull();
  });

  it("matches nothing for an empty location, an unknown one, or a malformed registry row", () => {
    expect(idOf("  ")).toBeNull();
    expect(idOf("车站")).toBeNull();
    expect(matchScene([null, "x", { name: "车站" }], "车站")).toEqual({
      name: "车站",
    });
  });
});
