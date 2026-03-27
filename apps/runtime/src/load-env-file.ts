import { resolve } from "node:path";
import process from "node:process";

export function loadProjectEnvFile(options: {
  cwd?: string;
  fileName?: string;
  preserveShellDatabaseUrl?: boolean;
} = {}): boolean {
  if (typeof process.loadEnvFile !== "function") {
    return false;
  }

  const cwd = options.cwd ?? process.cwd();
  const fileName = options.fileName ?? ".env";
  const previousDatabaseUrl = process.env.DATABASE_URL;

  try {
    process.loadEnvFile(resolve(cwd, fileName));

    if (options.preserveShellDatabaseUrl) {
      if (typeof previousDatabaseUrl === "string" && previousDatabaseUrl.length > 0) {
        process.env.DATABASE_URL = previousDatabaseUrl;
      } else {
        delete process.env.DATABASE_URL;
      }
    }

    return true;
  } catch {
    return false;
  }
}
