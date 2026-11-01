import { expect, it } from "vitest";
import type { StageCastModel } from "../src/extension-points.js";

it("lets providers opt into the bounded inferred departure policy", () => {
  const optedIn: StageCastModel = {
    actors: [],
    retainWhenEmpty: false,
    exitTransition: "fade",
  };
  const immediate: StageCastModel = {
    actors: [],
    retainWhenEmpty: false,
    exitTransition: "none",
  };
  const omitted: StageCastModel = { actors: [], retainWhenEmpty: true };
  expect([
    optedIn.exitTransition,
    immediate.exitTransition,
    omitted.exitTransition,
  ]).toEqual(["fade", "none", undefined]);
});
