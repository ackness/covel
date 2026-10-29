import { expect, it, vi } from "vitest";
import { verifyTrustedSourcesAtBoot } from "../../src/trust/boot.js";
it("continues boot even if verification unexpectedly fails", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const verifyAll = vi.fn().mockRejectedValue(new Error("damaged package"));
    await expect(
      verifyTrustedSourcesAtBoot({ verifyAll }),
    ).resolves.toBeUndefined();
    expect(verifyAll).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  } finally {
    warn.mockRestore();
  }
});
