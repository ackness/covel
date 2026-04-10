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

  // Try llm.toml first (slot-centric config)
  const llmResult = loadLlmConfig(resolve(projectRoot, "llm.toml"));
  if (llmResult) {
    config = llmResult.aiConfig;
    llmConfig = llmResult.llmConfig;
    console.log(
      `[ai-setup] Loaded llm.toml with slots:`,
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

/** Load the bundled model-db.json from the ai-provider package. */
function loadBundledModelDb(projectRoot: string): ModelDatabase | null {
  const dbPath = resolve(projectRoot, "packages/ai-provider/data/model-db.json");
  try {
    const raw = readFileSync(dbPath, "utf-8");
    const data: unknown = JSON.parse(raw);
    // Basic runtime validation of ModelDbFile shape
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
      console.warn("[ai-setup] model-db.json has invalid structure (missing updatedAt/count/models)");
      return null;
    }
    return createModelDatabase(data as ModelDbFile);
  } catch {
    console.warn("[ai-setup] Could not load bundled model-db.json");
    return null;
  }
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
