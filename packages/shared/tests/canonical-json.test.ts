import { expect, it } from "vitest";
import { canonicalJson } from "../src/index.js";

it("retains the sorted JSON representation used by suspension content digests", () => {
  expect(
    canonicalJson({ z: [null, { b: 2, a: 1 }], a: "x", omitted: undefined }),
  ).toBe('{"a":"x","z":[null,{"a":1,"b":2}]}');
  expect(canonicalJson([undefined, null])).toBe("[null,null]");
  expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
});
