import {
  CAPABILITY_KEYS,
  type CapabilityCeiling,
  type CapabilityKey,
} from "@covel/shared/permissions";
import { ApiError, requestResponse } from "./request.js";
import {
  updateServerCapabilities,
  type SharedServerInfo,
} from "./server-capabilities.js";

export {
  getDeploymentCapabilityCeiling,
  getSharedServerInfo,
  isDeploymentCapabilityDisabled,
  isModelRelaySupported,
  isOperatorTokenRequired,
  type SharedServerInfo,
} from "./server-capabilities.js";

// -- Server Info -------------------------------------------------

export interface ServerHealth {
  status: string;
  timestamp: string;
  version: string;
  bootId?: string;
  /** Whether this deployment checks the operator token on management requests. */
  operatorTokenRequired?: boolean;
  /** The server's deployment form and, when configured, its build's source. */
  deployment?: {
    form?: "personal" | "browser-private" | "hosted";
    /** Models on the player's computer or local network go through this browser. */
    modelRelay?: boolean;
    capabilities?: Partial<Record<CapabilityKey, CapabilityCeiling>>;
    source?: { repository?: string; commit?: string };
  };
  storage?: {
    data?: {
      backend?: "pg" | "sqlite" | "memory";
      durable?: boolean;
      frontendMode?: "local" | "remote";
    };
    media?: {
      backend?: "memory" | "sqlite" | "pg" | "s3" | "none";
      configuredBackend?: "mirror" | "memory" | "sqlite" | "pg" | "s3" | "none";
      enabled?: boolean;
      durable?: boolean;
    };
    vector?: {
      backend?: "embedded" | "none" | "external";
      capable?: boolean;
      driver?: "in-memory" | "sqlite-vec" | "pgvector" | "external" | "none";
      modelCount?: number;
      tableCount?: number;
    };
  };
}

const VALID_CEILINGS: ReadonlySet<string> = new Set([
  "enabled",
  "operator-only",
  "disabled",
]);

function sanitizeCapabilities(
  raw: unknown,
): Partial<Record<CapabilityKey, CapabilityCeiling>> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const out: Partial<Record<CapabilityKey, CapabilityCeiling>> = {};
  for (const key of CAPABILITY_KEYS) {
    const value = record[key];
    if (typeof value === "string" && VALID_CEILINGS.has(value)) {
      out[key] = value as CapabilityCeiling;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

function httpsAddress(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href.replace(/\/+$/, "")
      : undefined;
  } catch {
    return undefined;
  }
}

function sharedServerFrom(health: ServerHealth): SharedServerInfo | null {
  const form = health.deployment?.form;
  const shared = form === "browser-private" || form === "hosted";
  if (!shared || health.storage?.data?.frontendMode !== "local") return null;
  const source = health.deployment?.source;
  const repository = httpsAddress(source?.repository);
  const commit =
    typeof source?.commit === "string" && COMMIT_PATTERN.test(source.commit)
      ? source.commit
      : undefined;
  return {
    ...(repository ? { repository } : {}),
    ...(commit ? { commit } : {}),
  };
}

/** Boot must not hang on this; a captive portal or a wedged proxy never replies. */
const HEALTH_TIMEOUT_MS = 3000;

/**
 * `/api/health` is an untrusted boundary like any other: a captive portal or an
 * intercepting proxy happily answers 200 with an HTML login page, which used to
 * surface as a bare `SyntaxError` from `res.json()` far from the cause. Check
 * the status, and treat an unparseable or non-object body as a failed probe.
 */
export async function fetchServerHealth(): Promise<ServerHealth> {
  let res: Response;
  try {
    res = await requestResponse("/api/health", {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      silentErrors: true,
      retry: false,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw new Error(`[health] HTTP ${error.status}`, { cause: error });
    }
    throw error;
  }
  const body: unknown = await res.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("[health] response was not a JSON object");
  }
  const health = body as ServerHealth;
  updateServerCapabilities({
    operatorTokenRequired: health.operatorTokenRequired,
    sharedServer: sharedServerFrom(health),
    modelRelay: health.deployment?.modelRelay === true,
    deploymentCapabilities: sanitizeCapabilities(
      health.deployment?.capabilities,
    ),
  });
  return health;
}

