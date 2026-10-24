import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixture = fileURLToPath(
  new URL("./security-fixtures/outbound-encoding-security.ts", import.meta.url),
);

describe("outbound response encoding security", () => {
  it("survives CVE-2026-109869 and still reads a legitimate Brotli response", async ({
    signal,
  }) => {
    // A vulnerable Undici can reject fetch AND subsequently emit an unhandled
    // stream error. Keep that process death outside the Vitest worker, without
    // inheriting its setupFiles or in-process OUTBOUND_TEST_FETCH_HOOK.
    const { promise, resolve } = Promise.withResolvers<{
      code: number | string;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    }>();
    execFile(
      process.execPath,
      ["--import", "tsx", fixture],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        signal,
        timeout: 20_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error?.code ?? 0,
          signal: error?.signal ?? null,
          stdout,
          stderr,
        });
      },
    );
    const result = await promise;

    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(result.stdout.trim()).toBe("outbound encoding security passed");
  });
});
