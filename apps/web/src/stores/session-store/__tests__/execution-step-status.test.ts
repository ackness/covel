// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { toExecutionStepStatus } from "../execution-steps.js";

afterEach(() => vi.restoreAllMocks());

it("treats completion statuses as completed and an unrecognised one as unknown, logged once", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(toExecutionStepStatus("success")).toBe("completed");
  expect(toExecutionStepStatus(undefined)).toBe("completed");
  expect(warn).not.toHaveBeenCalled();
  expect(toExecutionStepStatus("paused-for-review")).toBe("unknown");
  expect(toExecutionStepStatus("paused-for-review")).toBe("unknown");
  expect(warn).toHaveBeenCalledTimes(1);
});
