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
  it("ignores other contracts, truncated operations and different equipment actions", () => {
    const changes = [{ op: "equip", name: "Sword" }];
    expect(
      unappliedInventoryChanges(changes, [
        operation([{ op: "equip", item: "Sword" }], {
          contract: "another.change@1",
        }),
        operation([{ op: "equip", item: "Sword" }], { truncated: true }),
        operation([{ op: "add", item: "Sword" }]),
        operation(null),
        operation([{}]),
      ]),
    ).toEqual({ changes, alreadyApplied: 0 });
  });
});
