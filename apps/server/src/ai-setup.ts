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
import { readRuntimeEnv } from "@covel/shared";
import type {
  AiConfig,
  LlmConfig,
  SlotRegistry,
  ModelSlotConfig,
  ModelDatabase,
  ModelDbFile,
} from "@covel/ai-provider";

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
 * configured; persistent llm.toml edits stay user-managed in the desktop
 * config directory, and request-scoped UI overrides ride through headers.
 */
interface LoadedAiConfig {
  config: AiConfig;
  llmConfig: LlmConfig;
  /**
   * Set only when an llm.toml file is present but failed to parse/validate
   * (and we fell back to the built-in default). A missing file is normal
   * (default config) and leaves this undefined.
   */
  error?: string;
}

/**
 * Load the AI config from llm.toml with built-in fallback.
 *
 * Resolution order:
 *   1. `llm.toml` (COVEL_LLM_TOML override, else ./llm.toml in cwd)
 *   2. Built-in DEFAULT_LLM_TOML — deepseek "story" slot, always available
 *
 * Never throws. A parse failure of a present file is reported via `error`
 * so the UI can tell the user *why* their slots vanished instead of
 * silently showing the fallback. Shared by `createAiStack` (boot) and
 * `reloadAiStack` (manual Settings reload).
 */
function loadAiConfig(): LoadedAiConfig {
  const env = readRuntimeEnv();
  // COVEL_LLM_TOML wins (desktop app passes a userData path); otherwise we
  // try ./llm.toml relative to the server's cwd.
  const llmTomlPath = env.llmToml
    ? resolve(env.llmToml)
    : resolve(process.cwd(), "llm.toml");

  // Any failure here (TOML parse error, unresolved ${ENV} interpolation,
  // schema validation) must fall back — never kill the server; the user can
  // fix their config through the Settings UI. A missing file returns null
  // (not an error) and uses the default.
  let llmResult: ReturnType<typeof loadLlmConfig> = null;
  let error: string | undefined;
  try {
    llmResult = loadLlmConfig(llmTomlPath);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.warn(
      `[ai-setup] llm.toml at ${llmTomlPath} could not be parsed: ${error}. ` +
        `Falling back to built-in default.`,
    );
  }

  if (llmResult) {
    console.log(
      `[ai-setup] Loaded llm.toml (${llmTomlPath}) with slots:`,
      Object.keys(llmResult.llmConfig.covel).join(", "),
    );
    return { config: llmResult.aiConfig, llmConfig: llmResult.llmConfig };
  }

  console.log(
    `[ai-setup] Using built-in default LLM config (deepseek/story). ` +
      `Override by editing ${llmTomlPath}.`,
  );
  const fallback = parseLlmConfig(DEFAULT_LLM_TOML);
  return {
    config: fallback.aiConfig,
    llmConfig: fallback.llmConfig,
    error,
  };
}

/** Build the slot map from preset tags. No hardcoded "default" alias. */
function buildSlotMap(config: AiConfig): Record<string, ModelSlotConfig> {
  const slots: Record<string, ModelSlotConfig> = {};
  for (const preset of config.presets) {
    if (preset.defaultSlot && preset.enabled) {
      slots[preset.defaultSlot] = {
        slotId: preset.defaultSlot,
        presetId: preset.id,
        tag: preset.tag ?? "text",
      };
    }
  }
  return slots;
}

export function createAiStack(): AiStack {
  // Load bundled LiteLLM model database (package-relative, works in dev and prod)
  const modelDb = loadBundledModelDb();
  if (modelDb) {
    setModelDatabase(modelDb);
    console.log(`[ai-setup] Model database loaded: ${modelDb.count} models`);
  }

  const loaded = loadAiConfig();

  const providerRegistry = createProviderRegistry({
    providerDefaults: loaded.config.providers,
  });

  const presetRegistry = createPresetRegistry({
    profiles: loaded.config.profiles,
    presets: loaded.config.presets,
  });

  const slotRegistry = createSlotRegistry({ presetRegistry });
  slotRegistry.configure({ slots: buildSlotMap(loaded.config) });

  const gateway = createGateway({
    providerRegistry,
    presetRegistry,
    slotRegistry,
  });

  return {
    config: loaded.config,
    llmConfig: loaded.llmConfig,
    lastLoadError: loaded.error,
    modelDb,
    providerRegistry,
    presetRegistry,
    slotRegistry,
    gateway,
  };
}

export interface AiReloadResult {
  /** true when llm.toml parsed (or is absent → default); false only when a present file failed to parse. */
  ok: boolean;
  /** Slot names active after the reload. */
  slots: string[];
  /** Parse error message when `ok` is false. */
  error?: string;
}

/**
 * Re-read llm.toml and apply it to the live `AiStack` in place.
 *
 * The registries are reconfigured (not replaced), so the gateway — which
 * holds them by reference and reads them per call — and every adapter built
 * on top of it pick up the new slots/providers without a restart. The
 * `modelDb` is left untouched (it doesn't come from llm.toml).
 *
 * Best-effort with respect to in-flight requests: reconfiguration is
 * synchronous, so a turn that already resolved its slot completes against
 * the previous config; the next turn sees the new one.
 */
export function reloadAiStack(ai: AiStack): AiReloadResult {
  const loaded = loadAiConfig();

  ai.providerRegistry.reconfigure({
    providerDefaults: loaded.config.providers,
  });
  ai.presetRegistry.reconfigure({
    profiles: loaded.config.profiles,
    presets: loaded.config.presets,
  });
  ai.slotRegistry.configure({ slots: buildSlotMap(loaded.config) });

  ai.config = loaded.config;
  ai.llmConfig = loaded.llmConfig;
  ai.lastLoadError = loaded.error;

  return {
    ok: loaded.error === undefined,
    slots: Object.keys(loaded.llmConfig.covel),
    error: loaded.error,
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
  const env = readRuntimeEnv();
  const candidates = [
    env.modelDbPath,
    env.userConfigDir ? resolve(env.userConfigDir, "model-db.json") : undefined,
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
  /**
   * Set when the most recent llm.toml load failed to parse and fell back to
   * the built-in default. Surfaced via GET /api/llm-config so the UI can show
   * the user why their configured slots are absent. Undefined on success.
   */
  lastLoadError?: string;
  /** Model capability database (LiteLLM-derived). */
  modelDb: ModelDatabase | null;
  providerRegistry: ReturnType<typeof createProviderRegistry>;
  presetRegistry: ReturnType<typeof createPresetRegistry>;
  slotRegistry: SlotRegistry;
  gateway: ReturnType<typeof createGateway>;
}
