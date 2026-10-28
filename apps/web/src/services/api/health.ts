import { ApiError, requestResponse } from "./request.js";

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

let operatorTokenRequired: boolean | undefined;
let sharedServer: SharedServerInfo | null = null;
let modelRelay = false;

/**
 * A shared server that keeps players' saves in their own browsers: the
 * browser-private form, or a hosted tier on the memory store. Its players see
 * a notice about where their data and keys go.
 */
export interface SharedServerInfo {
  /** The public source repository, an https address. */
  readonly repository?: string;
  /** The commit the running build was made from. */
  readonly commit?: string;
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
  if (typeof health.operatorTokenRequired === "boolean") {
    operatorTokenRequired = health.operatorTokenRequired;
  }
  sharedServer = sharedServerFrom(health);
  modelRelay = health.deployment?.modelRelay === true;
  return health;
}

/**
 * True when the server reaches models on the player's computer or local
 * network through this browser (the local model relay).
 */
export function isModelRelaySupported(): boolean {
  return modelRelay;
}

/**
 * Null until a server has answered, and on a server whose saves are not kept
 * in the player's browser.
 */
export function getSharedServerInfo(): SharedServerInfo | null {
  return sharedServer;
}

/**
 * What the last health reply said about the operator token. Undefined until
 * a server has answered; a caller that hides the token entry on `false` must
 * keep it on `undefined`, or a hosted operator has no place to enter it.
 */
export function isOperatorTokenRequired(): boolean | undefined {
  return operatorTokenRequired;
}
