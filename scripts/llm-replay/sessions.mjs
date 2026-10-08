// The recorded scripted sessions under tests/llm-replay/<name>/:
//
//   scenario.json  what `scripts/e2e-plugin-verify.ts` plays
//   llm.toml       the models the session was recorded with
//   recording/     one answer per request, named after the request digest
//
// run.mjs plays them through the replay proxy. Docs:
// docs/guide/e2e-plugin-verify.md
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const listSessions = (root) =>
  existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            existsSync(join(root, entry.name, "scenario.json")),
        )
        .map((entry) => entry.name)
        .sort()
    : [];

export const readScenario = (root, name) => {
  const file = join(root, name, "scenario.json");
  if (!existsSync(file)) throw new Error(`no session ${name} (${file})`);
  const scenario = JSON.parse(readFileSync(file, "utf8"));
  for (const field of ["world", "sessionId", "seed"])
    if (typeof scenario[field] !== "string" || scenario[field] === "")
      throw new Error(`${name}/scenario.json: "${field}" must be a text`);
  if (!Number.isInteger(scenario.turns) || scenario.turns < 1)
    throw new Error(`${name}/scenario.json: "turns" must be a whole number`);
  const args = scenario.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
    throw new Error(`${name}/scenario.json: "args" must be a list of texts`);
  return { locale: "zh-CN", ...scenario, args };
};

// Every slot goes to the proxy: its `baseUrl` is replaced, and a slot without
// one would go to the provider's own endpoint. `[covel.<slot>.<table>]` is
// part of its slot.
const SLOT = /^\s*\[\s*covel\.([^.\]\s]+)\s*\]/;
const TABLE = /^\s*\[/;
const KEY = /^(\s*)(baseUrl|provider)(\s*=\s*)(["'])(.*?)\4(.*)$/;

/** The session's llm.toml with every slot pointed at `proxyUrl`. */
export const pointAtProxy = (toml, proxyUrl) => {
  const slots = [];
  let slot;
  const lines = toml.split(/\r?\n/).map((line) => {
    if (TABLE.test(line)) {
      const name = line.match(SLOT)?.[1];
      slot = name ? { name, baseUrl: false, provider: undefined } : undefined;
      if (slot) slots.push(slot);
      return line;
    }
    const key = line.match(KEY);
    if (!slot || !key) return line;
    if (key[2] === "provider") {
      slot.provider = key[5];
      return line;
    }
    slot.baseUrl = true;
    return `${key[1]}baseUrl${key[3]}"${proxyUrl}/v1"${key[6]}`;
  });
  const incomplete = slots.filter((s) => !s.baseUrl || !s.provider);
  if (slots.length === 0 || incomplete.length > 0)
    throw new Error(
      `llm.toml: every [covel.<slot>] needs a provider and a baseUrl${incomplete.length > 0 ? ` (${incomplete.map((s) => s.name).join(", ")})` : ""}`,
    );
  return {
    text: lines.join("\n"),
    providers: [...new Set(slots.map((s) => s.provider))],
  };
};

/** The variable the server reads a provider's key from. */
export const apiKeyName = (provider) =>
  `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
