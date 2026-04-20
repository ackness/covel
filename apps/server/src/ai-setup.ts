import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import {
  loadLlmConfig,
  parseLlmConfig,
  createProviderRegistry,
  createPresetRegistry,
  createSlotRegistry,
  createGateway,
  createModelDatabase,
  setModelDatabase,
  BUNDLED_MODEL_DB_PATH,
} from "@covel/ai-provider";
import type { AiConfig, LlmConfig, SlotRegistry, ModelDatabase, ModelDbFile } from "@covel/ai-provider";

/**
 * Built-in fallback LLM config used when no llm.toml is present.
 *
 * The desktop app must boot even if the user has never touched Settings.
 * This defines a single `story` slot pointing at DeepSeek, which all
 * plugin runtimes (model: "story" and model: "plugin") will resolve to
 * via the gateway's first-slot fallback. Users override this by writing
 * their own llm.toml via the Settings UI.
 *
 * Note: no API keys live here. The user still must provide
 * DEEPSEEK_API_KEY (via .env.llm or the Settings UI → X-Provider-Keys)
 * before the slot can actually be called.
 */
const DEFAULT_LLM_TOML = `
[covel.story]
provider = "deepseek"
model    = "deepseek-chat"
baseUrl  = "https://api.deepseek.com"
protocol = "openai-chat-v1"
`;

/**
 * Initialize AI provider stack.
 *
 * Resolution order:
 *   1. `llm.toml` (COVEL_LLM_TOML override, else ./llm.toml in cwd)
 *   2. Built-in DEFAULT_LLM_TOML — deepseek "story" slot, always available
 *
 * We never throw on missing config. The desktop app can boot with nothing
 * configured; users can then add slots / keys through the Settings UI,
 * which writes to userConfigDir/llm.toml for subsequent launches.
 */
export function createAiStack(): AiStack {
  let config: AiConfig;
  let llmConfig: LlmConfig | null = null;

  // Load bundled LiteLLM model database (package-relative, works in dev and prod)
  const modelDb = loadBundledModelDb();
  if (modelDb) {
    setModelDatabase(modelDb);
    console.log(`[ai-setup] Model database loaded: ${modelDb.count} models`);
  }

  // Try llm.toml first. COVEL_LLM_TOML wins (desktop app passes a userData path);
  // otherwise we try ./llm.toml relative to the server's cwd.
  const llmTomlPath = process.env.COVEL_LLM_TOML
    ? resolve(process.env.COVEL_LLM_TOML)
    : resolve(process.cwd(), "llm.toml");

  // Any failure here (missing file, TOML parse error, unresolved ${ENV}
  // interpolation, schema validation) must fall back — never kill the
  // server, the user can fix their config through the Settings UI.
  let llmResult: ReturnType<typeof loadLlmConfig> = null;
  try {
    llmResult = loadLlmConfig(llmTomlPath);
  } catch (err) {
    console.warn(
      `[ai-setup] llm.toml at ${llmTomlPath} could not be parsed: ${err instanceof Error ? err.message : err}. ` +
        `Falling back to built-in default.`,
    );
  }
  if (llmResult) {
    config = llmResult.aiConfig;
    llmConfig = llmResult.llmConfig;
    console.log(
      `[ai-setup] Loaded llm.toml (${llmTomlPath}) with slots:`,
      Object.keys(llmResult.llmConfig.covel).join(", "),
    );
  } else {
    console.log(
      `[ai-setup] Using built-in default LLM config (deepseek/story). ` +
        `Override by editing ${llmTomlPath}.`,
    );
    const fallback = parseLlmConfig(DEFAULT_LLM_TOML);
    config = fallback.aiConfig;
    llmConfig = fallback.llmConfig;
  }

  const providerRegistry = createProviderRegistry({
    providerDefaults: config.providers,
  });

  const presetRegistry = createPresetRegistry({
    profiles: config.profiles,
    presets: config.presets,
  });

  const slotRegistry = createSlotRegistry({ presetRegistry });

  // Build slot map from preset tags. No hardcoded "default" alias.
  {
    const slots: Record<string, import("@covel/ai-provider").ModelSlotConfig> = {};

    for (const preset of config.presets) {
      if (preset.defaultSlot && preset.enabled) {
        slots[preset.defaultSlot] = {
          slotId: preset.defaultSlot,
          presetId: preset.id,
          tag: preset.tag ?? "text",
          ...(preset.imageApi !== undefined ? { imageApi: preset.imageApi } : {}),
        };
      }
    }

    slotRegistry.configure({ slots });
  }

  const gateway = createGateway({ providerRegistry, presetRegistry, slotRegistry });

  return {
    config,
    llmConfig,
    modelDb,
    providerRegistry,
    presetRegistry,
    slotRegistry,
    gateway,
  };
}

/**
 * Load the model database.
 *
 * Resolution order:
 *   1. `COVEL_MODEL_DB_PATH` explicit override
 *   2. `COVEL_USER_CONFIG_DIR/model-db.json` — user cache populated via the
 *      "Refresh model DB" action in Settings
 *   3. Bundled `data/model-db.json` shipped inside @covel/ai-provider
 *
 * The first file that parses into a valid `ModelDbFile` is used. This lets
 * the desktop app ship with a baseline database but still receive updates
 * without re-releasing the app.
 */
function loadBundledModelDb(): ModelDatabase | null {
  const candidates = [
    process.env.COVEL_MODEL_DB_PATH,
    process.env.COVEL_USER_CONFIG_DIR
      ? resolve(process.env.COVEL_USER_CONFIG_DIR, "model-db.json")
      : undefined,
    BUNDLED_MODEL_DB_PATH,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const dbPath of candidates) {
    try {
      const raw = readFileSync(dbPath, "utf-8");
      const data: unknown = JSON.parse(raw);
      if (
        !data ||
        typeof data !== "object" ||
        !("updatedAt" in data) ||
        typeof (data as Record<string, unknown>).updatedAt !== "string" ||
        !("count" in data) ||
        typeof (data as Record<string, unknown>).count !== "number" ||
        !("models" in data) ||
        typeof (data as Record<string, unknown>).models !== "object" ||
        (data as Record<string, unknown>).models === null
      ) {
        console.warn(`[ai-setup] model-db.json invalid structure at ${dbPath}`);
        continue;
      }
      console.log(`[ai-setup] Loaded model-db from ${dbPath}`);
      return createModelDatabase(data as ModelDbFile);
    } catch {
      // try next candidate
    }
  }
  console.warn("[ai-setup] Could not load any model-db.json");
  return null;
}

export interface AiStack {
  config: AiConfig;
  /** Parsed llm.toml config. Always populated — falls back to built-in defaults. */
  llmConfig: LlmConfig | null;
  /** Model capability database (LiteLLM-derived). */
  modelDb: ModelDatabase | null;
  providerRegistry: ReturnType<typeof createProviderRegistry>;
  presetRegistry: ReturnType<typeof createPresetRegistry>;
  slotRegistry: SlotRegistry;
  gateway: ReturnType<typeof createGateway>;
}
