import {
  apiKeyEnvNameToProviderId,
  providerIdToApiKeyEnvName,
} from "../utils/provider-keys.js";
import {
  COVEL_ENV_REGISTRY,
  type CovelEnvName,
  type CovelFeatureFlag,
  type EnvVarDefinition,
} from "./registry-definitions.js";

export type EnvSource = Record<string, string | undefined>;

function defaultSource(): EnvSource {
  const globalProcess = (globalThis as { process?: { env?: EnvSource } })
    .process;
  return globalProcess?.env ?? {};
}

export function getEnvDefinition(name: string): EnvVarDefinition | undefined {
  return COVEL_ENV_REGISTRY.find((item) => item.name === name);
}

export function readEnvString(
  name: CovelEnvName | string,
  fallback?: string,
  source: EnvSource = defaultSource(),
): string | undefined {
  const value = source[name];
  if (value === undefined || value === "") return fallback;
  return value;
}

export function readEnvInt(
  name: CovelEnvName | string,
  fallback: number,
  source: EnvSource = defaultSource(),
): number {
  const raw = readEnvString(name, undefined, source);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readEnvChoice<T extends string>(
  name: CovelEnvName | string,
  choices: readonly T[],
  fallback: T,
  source: EnvSource = defaultSource(),
): T {
  const raw = readEnvString(name, undefined, source);
  return choices.includes(raw as T) ? (raw as T) : fallback;
}

export function readEnvCsv(
  name: CovelEnvName | string,
  source: EnvSource = defaultSource(),
): string[] {
  const raw = readEnvString(name, undefined, source);
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isEnvEnabled(
  name: CovelFeatureFlag,
  source: EnvSource = defaultSource(),
): boolean {
  return source[name] === "1";
}

export function isEnvTruthy(
  name: CovelEnvName | string,
  source: EnvSource = defaultSource(),
): boolean {
  const raw = source[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

export function isEnvDefaultOn(
  name: CovelEnvName | string,
  source: EnvSource = defaultSource(),
): boolean {
  const raw = source[name]?.trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}

export function providerApiKeysFromEnv(
  source: EnvSource = defaultSource(),
): Record<string, string> {
  const apiKeys: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const provider = apiKeyEnvNameToProviderId(key);
    if (provider && value) apiKeys[provider] = value;
  }
  return apiKeys;
}

export function providerApiKeyEnvName(providerId: string): string | null {
  return providerIdToApiKeyEnvName(providerId);
}

const DEPLOYMENT_TIERS = ["self", "demo", "commercial"] as const;
export type DeploymentTier = (typeof DEPLOYMENT_TIERS)[number];

/**
 * DEPLOYMENT_TIER gates owner-token enforcement (session-guard.ts) and the
 * media cleanup endpoint (media.ts) — a typo or case mismatch (e.g.
 * "Commercial") must not silently downgrade a hosted deployment to the open
 * "self" posture. Reject unknown values fail-safe to the most restrictive
 * tier rather than passing the raw string through.
 */
function readDeploymentTier(source: EnvSource): DeploymentTier {
  const raw = readEnvString("DEPLOYMENT_TIER", undefined, source);
  if (raw === undefined) return "self";
  const normalized = raw.trim().toLowerCase();
  if ((DEPLOYMENT_TIERS as readonly string[]).includes(normalized)) {
    return normalized as DeploymentTier;
  }
  console.warn(
    `[env] Unknown DEPLOYMENT_TIER "${raw}" — falling back to "commercial" (most restrictive). Expected one of: ${DEPLOYMENT_TIERS.join(", ")}.`,
  );
  return "commercial";
}

function readSqlitePath(source: EnvSource): string {
  const explicit = readEnvString("SQLITE_PATH", undefined, source);
  if (explicit) return explicit;
  const dataRoot = readEnvString("COVEL_DATA_ROOT", undefined, source);
  return dataRoot
    ? `${dataRoot.replace(/[\\/]+$/, "")}/covel.db`
    : "./data/covel.db";
}

export function readRuntimeEnv(source: EnvSource = defaultSource()) {
  return {
    storeBackend: readEnvChoice(
      "STORE_BACKEND",
      ["memory", "sqlite", "pg"] as const,
      "sqlite",
      source,
    ),
    sqlitePath: readSqlitePath(source),
    databaseUrl: readEnvString("DATABASE_URL", undefined, source),
    mediaBackend: readEnvChoice(
      "MEDIA_BACKEND",
      ["mirror", "memory", "sqlite", "pg", "none"] as const,
      "mirror",
      source,
    ),
    mediaRoot: readEnvString("MEDIA_ROOT", undefined, source),
    mediaTokenSecret: readEnvString(
      "COVEL_MEDIA_TOKEN_SECRET",
      undefined,
      source,
    ),
    vectorBackend: readEnvChoice(
      "VECTOR_BACKEND",
      ["embedded", "none", "external"] as const,
      "embedded",
      source,
    ),
    serverPort: readEnvInt("SERVER_PORT", 3001, source),
    // Loopback by default (audit S-02): T1 self-deploy / desktop must not
    // expose the unauthenticated API on all interfaces. Containers and
    // multi-pod deploys opt into a public interface explicitly.
    bindHost: readEnvString("COVEL_BIND_HOST", "127.0.0.1", source)!,
    nodeEnv: readEnvChoice(
      "NODE_ENV",
      ["development", "production", "test"] as const,
      "development",
      source,
    ),
    serveStatic: isEnvTruthy("SERVE_STATIC", source),
    staticDir: readEnvString("STATIC_DIR", "./web-dist", source)!,
    deploymentTier: readDeploymentTier(source),
    corsOrigins: readEnvCsv("CORS_ORIGIN", source),
    debugRoutes: isEnvTruthy("ENABLE_DEBUG_PAGE", source),
    installApiEnabled: isEnvTruthy("COVEL_INSTALL_API_ENABLED", source),
    rateLimitRpm: readEnvInt("RATE_LIMIT_RPM", 60, source),
    trustedProxyIps: readEnvString("TRUSTED_PROXY_IPS", undefined, source),
    covelHome: readEnvString("COVEL_HOME", undefined, source),
    dataRoot: readEnvString("COVEL_DATA_ROOT", undefined, source),
    desktopRest: isEnvTruthy("COVEL_DESKTOP_REST", source),
    desktopRestToken: readEnvString(
      "COVEL_DESKTOP_REST_TOKEN",
      undefined,
      source,
    ),
    llmToml: readEnvString("COVEL_LLM_TOML", undefined, source),
    pluginsDir: readEnvString("COVEL_PLUGINS_DIR", undefined, source),
    userPluginsDir: readEnvString("COVEL_USER_PLUGINS_DIR", undefined, source),
    worldsDir: readEnvString("COVEL_WORLDS_DIR", undefined, source),
    userWorldsDir: readEnvString("COVEL_USER_WORLDS_DIR", undefined, source),
    userConfigDir: readEnvString("COVEL_USER_CONFIG_DIR", undefined, source),
    logsDir: readEnvString("COVEL_LOGS_DIR", undefined, source),
    modelDbPath: readEnvString("COVEL_MODEL_DB_PATH", undefined, source),
    promptsDir: readEnvString("COVEL_PROMPTS_DIR", undefined, source),
    compactorContextWindow: readEnvInt(
      "COVEL_COMPACTOR_CONTEXT_WINDOW",
      32768,
      source,
    ),
  };
}
