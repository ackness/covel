import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { chooseWorldId } from "../../src/world-import/st/convert.js";
it.each([
  ["Quiet Harbor!", "quiet-harbor"],
  ["A".repeat(100), "a".repeat(48)],
  [
    "12 Islands",
    `st-${createHash("sha256").update("12 Islands").digest("hex").slice(0, 8)}`,
  ],
  [
    "明灯",
    `st-${createHash("sha256").update("明灯").digest("hex").slice(0, 8)}`,
  ],
])("names %s", async (name, id) =>
  expect(await chooseWorldId(name, async () => false)).toBe(id),
);
it("appends suffixes within length limit", async () =>
  expect(
    await chooseWorldId("A".repeat(100), async (id) => !id.endsWith("-3")),
  ).toBe("a".repeat(46) + "-3"));
it("stops after twenty candidates", async () => {
  const taken = vi.fn(async () => true);
  await expect(chooseWorldId("Mira", taken)).rejects.toMatchObject({
    code: "id-conflict",
    httpStatus: 409,
  });
  expect(taken).toHaveBeenCalledTimes(20);
});
