import { describe, expect, it } from "vitest";
import { unappliedInventoryChanges } from "../lib/applied-operations.js";

const operation = (changes, extra = {}) => ({
  contract: "inventory.change@1",
  request: { changes },
  ...extra,
});
describe("inventory changes already applied through services", () => {
  it("removes matching payment and goods, with the operation's quantities authoritative", () => {
    const torch = { op: "add", name: "Torch" };
    expect(
      unappliedInventoryChanges(
        [
          { op: "remove", name: " gold ", quantity: 1 },
          { op: "add", name: "sword", quantity: 7 },
          torch,
        ],
        [
          operation([
            { op: "remove", item: "Gold", quantity: 10 },
            { op: "add", item: " Sword " },
          ]),
        ],
      ),
    ).toEqual({ changes: [torch], alreadyApplied: 2 });
  });
  it("consumes only the first match for each operation change, across multiple operations", () => {
    const gains = [
      { op: "add", name: "Sword", quantity: 1 },
      { op: "add", name: "Sword", quantity: 2 },
    ];
    const applied = operation([{ op: "add", item: "Sword" }]);
    expect(unappliedInventoryChanges(gains, [applied])).toEqual({
      changes: [gains[1]],
      alreadyApplied: 1,
    });
    expect(unappliedInventoryChanges(gains, [applied, applied])).toEqual({
      changes: [],
      alreadyApplied: 2,
    });
    expect(gains).toHaveLength(2);
  });
  it("uses a retained request even when only the result was truncated", () => {
    expect(
      unappliedInventoryChanges(
        [{ op: "add", name: "Sword" }],
        [operation([{ op: "add", item: "Sword" }], { truncated: true })],
      ),
    ).toEqual({ changes: [], alreadyApplied: 1 });
  });
  it("uses retained results without treating final quantities as deltas or repeating both views", () => {
    const changes = [
      { op: "add", name: "Sword", quantity: 1 },
      { op: "add", name: "Sword", quantity: 2 },
      { op: "remove", name: "Gold", quantity: 10 },
      { op: "equip", name: "Sword" },
    ];
    const results = [
      { op: "add", item: "sword", quantity: 10, status: "updated" },
      { op: "remove", item: "Gold", quantity: 90, status: "updated" },
      { op: "equip", item: "Sword", status: "skipped" },
    ];
    const expected = { changes: [changes[1]], alreadyApplied: 3 };
    expect(
      unappliedInventoryChanges(changes, [
        {
          contract: "inventory.change@1",
          result: { results },
          truncated: true,
        },
      ]),
    ).toEqual(expected);
    expect(
      unappliedInventoryChanges(changes, [
        operation(results, { result: { results } }),
      ]),
    ).toEqual(expected);
  });
  it("ignores other contracts, absent operation details and different equipment actions", () => {
    const changes = [{ op: "equip", name: "Sword" }];
    expect(
      unappliedInventoryChanges(changes, [
        operation([{ op: "equip", item: "Sword" }], {
          contract: "another.change@1",
        }),
        { contract: "inventory.change@1", truncated: true },
        operation([{ op: "add", item: "Sword" }]),
        operation(null),
        operation([{}]),
      ]),
    ).toEqual({ changes, alreadyApplied: 0 });
  });
});
