import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

// Drizzle is a maintenance tool, not the application schema upgrade path.
// loadEnvFile preserves explicit shell overrides.
const envPath = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envPath)) loadEnvFile(envPath);

export default defineConfig({
  out: "./drizzle",
  schema: "../../packages/store/src/postgres/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
