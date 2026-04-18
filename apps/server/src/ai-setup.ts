import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import {
  loadAiConfig,
  loadLlmConfig,
  createProviderRegistry,
  createPresetRegistry,
  createSlotRegistry,
  createGateway,
  createModelDatabase,
  setModelDatabase,
} from "@covel/ai-provider";
import type { AiConfig, LlmConfig, SlotRegistry, ModelDatabase, ModelDbFile } from "@covel/ai-provider";


/**
 * Initialize AI provider stack.
 *
 * Configuration priority:
 *   1. `llm.toml` at project root  — slot-centric, user-friendly
 *   2. `packages/ai-provider/presets/default.toml` — legacy fallback
 *
 * Called once at server startup after dotenv is loaded.
 */
export function createAiStack(): AiStack {
  const projectRoot = resolve(import.meta.dirname, "../../..");
  let config: AiConfig;
  let llmConfig: LlmConfig | null = null;

  // Load bundled LiteLLM model database
  const modelDb = loadBundledModelDb(projectRoot);
  if (modelDb) {
    setModelDatabase(modelDb);
    console.log(`[ai-setup] Model database loaded: ${modelDb.count} models`);
  }

  // Try llm.toml first (slot-centric config).
  // COVEL_LLM_TOML can point to a user-editable override (typically under
  // Electron userData). When set, we prefer it over the bundled copy.
  const llmTomlPath = process.env.COVEL_LLM_TOML
    ? resolve(process.env.COVEL_LLM_TOML)
    : resolve(projectRoot, "llm.toml");
  const llmResult = loadLlmConfig(llmTomlPath);
  if (llmResult) {
    config = llmResult.aiConfig;
    llmConfig = llmResult.llmConfig;
    console.log(
      `[ai-setup] Loaded llm.toml (${llmTomlPath}) with slots:`,
      Object.keys(llmResult.llmConfig.covel).join(", "),
    );
  } else {
    // Fallback to legacy default.toml
    console.log("[ai-setup] No llm.toml found, using default.toml");
    process.env.DEEPSEEK_BASE_URL ??= "https://api.deepseek.com";
    process.env.DASHSCOPE_BASE_URL ??= "https://dashscope.aliyuncs.com/compatible-mode/v1";
    config = loadAiConfig(
      resolve(projectRoot, "packages/ai-provider/presets/default.toml"),
    );
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
 *   3. Bundled `packages/ai-provider/data/model-db.json`
 *
 * The first file that parses into a valid `ModelDbFile` is used. This lets
 * the desktop app ship with a baseline database but still receive updates
 * without re-releasing the app.
 */
function loadBundledModelDb(projectRoot: string): ModelDatabase | null {
  const candidates = [
    process.env.COVEL_MODEL_DB_PATH,
    process.env.COVEL_USER_CONFIG_DIR
      ? resolve(process.env.COVEL_USER_CONFIG_DIR, "model-db.json")
      : undefined,
    resolve(projectRoot, "packages/ai-provider/data/model-db.json"),
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
  /** Parsed llm.toml config (null when using legacy default.toml). */
  llmConfig: LlmConfig | null;
  /** Model capability database (LiteLLM-derived). */
  modelDb: ModelDatabase | null;
  providerRegistry: ReturnType<typeof createProviderRegistry>;
  presetRegistry: ReturnType<typeof createPresetRegistry>;
  slotRegistry: SlotRegistry;
  gateway: ReturnType<typeof createGateway>;
}
