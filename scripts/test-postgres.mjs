import { fileURLToPath } from "node:url";
import { spawnCommand } from "./lib/command-shim.mjs";

const cwd = fileURLToPath(new URL("../", import.meta.url));

if (!process.env.DATABASE_URL?.trim()) {
  console.error(
    "test:pg requires DATABASE_URL in the environment or root .env.",
  );
  process.exitCode = 1;
} else {
  // Database availability is external state; these checks always run directly.
  const env = { ...process.env, COVEL_REQUIRE_PG_TESTS: "1" };
  const commands = [
    [
      "--filter",
      "@covel/store",
      "exec",
      "vitest",
      "run",
      "tests/pg-store.test.ts",
      "tests/pg-schema-version.test.ts",
      "tests/vector-store.test.ts",
      "tests/media-store.test.ts",
      "tests/schema-ddl-codegen.test.ts",
    ],
    ["--filter", "@covel/server", "exec", "vitest", "run", "tests/integration"],
  ];
  for (const args of commands) {
    const code = await new Promise((resolve) => {
      const child = spawnCommand("pnpm", args, { cwd, env, stdio: "inherit" });
      child.once("error", (error) => {
        console.error(`Unable to start PostgreSQL tests: ${error.message}`);
        resolve(1);
      });
      child.once("exit", (code) => resolve(code ?? 1));
    });
    if (code !== 0) {
      process.exitCode = code;
      break;
    }
  }
}
