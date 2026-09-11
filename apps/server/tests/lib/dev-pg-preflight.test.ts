import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const script = resolve(
  import.meta.dirname,
  "../../../../scripts/dev-pg-preflight.mjs",
);

it("loads the root env and probes the configured database rather than port 5432", async () => {
  const dir = await mkdtemp(join(tmpdir(), "covel-pg-preflight-"));
  const server = createServer((socket) => socket.end());
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No TCP address");
  const env = { PATH: process.env.PATH };
  try {
    for (const config of [
      `DATABASE_URL=postgresql://fixture:fixture@127.0.0.1:${address.port}/fixture`,
      `POSTGRES_PORT=${address.port}`,
      `DATABASE_URL=postgresql://fixture:fixture@invalid.example:1/fixture\nCOVEL_PG_PREFLIGHT_HOST=127.0.0.1\nCOVEL_PG_PREFLIGHT_PORT=${address.port}`,
    ]) {
      await writeFile(join(dir, ".env"), config, "utf8");
      const result = await run(
        process.execPath,
        ["--env-file-if-exists=.env", script],
        {
          cwd: dir,
          env,
          timeout: 5000,
        },
      );
      expect(result.stderr).toBe("");
    }
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects an invalid database URL without printing credentials", async () => {
  await expect(
    run(process.execPath, [script], {
      env: { DATABASE_URL: "invalid:synthetic-secret" },
      timeout: 5000,
    }),
  ).rejects.toMatchObject({
    code: 1,
    stderr: "[dev:pg] DATABASE_URL must be a valid PostgreSQL URL.\n",
  });
});
