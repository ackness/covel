import { describe, expect, it } from "vitest";
import {
  compactJobId,
  formatJobDuration,
  jobStatusBadgeVariant,
} from "../job-ui.js";

describe("job-ui helpers", () => {
  it("compacts long job ids with a stable prefix", () => {
    expect(compactJobId("1234567890")).toBe("1234567890");
    expect(compactJobId("12345678901")).toBe("12345678…");
    expect(
      compactJobId("12345678901234567890", {
        maxLength: 14,
        prefixLength: 14,
      }),
    ).toBe("12345678901234…");
  });

  it("formats short and long durations", () => {
    expect(formatJobDuration(999)).toBe("999ms");
    expect(formatJobDuration(1200)).toBe("1s");
    expect(formatJobDuration(1200, { style: "fixed" })).toBe("1.2s");
    expect(formatJobDuration(61_000, { style: "fixed" })).toBe("61.0s");
    expect(formatJobDuration(61_000, { style: "clock" })).toBe("1m1s");
    expect(formatJobDuration(undefined, { emptyValue: "—" })).toBe("—");
  });

  it("maps job statuses to badge variants", () => {
    expect(jobStatusBadgeVariant("failed")).toBe("destructive");
    expect(jobStatusBadgeVariant("done")).toBe("default");
    expect(jobStatusBadgeVariant("completed")).toBe("default");
    expect(jobStatusBadgeVariant("pending")).toBe("secondary");
    expect(jobStatusBadgeVariant("running")).toBe("secondary");
    expect(jobStatusBadgeVariant("unknown")).toBe("outline");
  });
});
