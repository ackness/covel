import fs from "node:fs";

/** Only inspect the server root; plugin-owned configuration is a separate contract. */
export function assertNoPrivateConfig(serverRoot) {
  const names = fs.readdirSync(serverRoot);
  const privateNames = names.filter(
    (name) =>
      name === "llm.toml" ||
      name.startsWith("llm.toml.") ||
      name === "config.toml" ||
      name === "keys.env" ||
      name === ".env" ||
      name.startsWith(".env."),
  );
  if (privateNames.length > 0) {
    throw new Error(
      `Private configuration must not be packaged: ${privateNames.join(", ")}`,
    );
  }
}
