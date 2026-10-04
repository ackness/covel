import { ApiError, requestResponse } from "./request.js";

// -- Server Info -------------------------------------------------

export interface ServerHealth {
  status: string;
  timestamp: string;
  version: string;
  bootId?: string;
  /** Whether this deployment checks the operator token on management requests. */
  operatorTokenRequired?: boolean;
  storage?: {
    data?: {
      backend?: "pg" | "sqlite" | "memory";
      durable?: boolean;
      frontendMode?: "local" | "remote";
    };
    media?: {
      backend?: "memory" | "sqlite" | "pg" | "s3" | "idb" | "none";
      configuredBackend?:
        "mirror" | "memory" | "sqlite" | "pg" | "s3" | "idb" | "none";
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
  return health;
}

/**
 * What the last health reply said about the operator token. Undefined until
 * a server has answered; a caller that hides the token entry on `false` must
 * keep it on `undefined`, or a hosted operator has no place to enter it.
 */
export function isOperatorTokenRequired(): boolean | undefined {
  return operatorTokenRequired;
}
