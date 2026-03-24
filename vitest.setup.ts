import process from "node:process";

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(".env");
  } catch {
    // Ignore missing local env files in CI and shared environments.
  }
}
