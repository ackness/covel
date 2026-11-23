import type { ProviderFailureKind } from "@covel/shared";
import type {
  ProviderSourceCredentialStatus,
  ProviderSourceMode,
  ProviderSourceRequestShape,
} from "@covel/shared/platform";

export type {
  ProviderSourceCredentialStatus,
  ProviderSourceMode,
  ProviderSourceRequestShape,
};

export interface ProviderSourceErrorClassification {
  readonly kind: ProviderFailureKind;
  readonly retryAfterMs?: number;
  readonly message?: string;
}

export interface SourceWireErrorContext {
  readonly body?: unknown;
  readonly message?: string;
}

const sourceWireErrorContexts = new WeakMap<Error, SourceWireErrorContext>();

/**
 * Attach raw internal error details/message from a source-backed custom wire to
 * its sanitized `AiProviderError` so same-package `classifyError()` can inspect
 * them without exposing raw upstream text outside the package boundary.
 */
export function attachSourceWireErrorContext(
  error: Error,
  context: SourceWireErrorContext,
): void {
  sourceWireErrorContexts.set(error, context);
}

export function readSourceWireErrorContext(
  error: Error,
): SourceWireErrorContext | undefined {
  return sourceWireErrorContexts.get(error);
}

export interface ProviderSourceAttemptContext {
  readonly sourceId: string;
  readonly approvedInstanceOwner?: string;
  readonly declaredBaseUrl: string;
  readonly declaredProtocol: string;
  readonly accountId?: string;
  readonly baseUrl: string;
  readonly protocol: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly credentialGeneration?: number;
  readonly requestShape?: ProviderSourceRequestShape;
  readonly classifyError?: (error: {
    readonly statusCode?: number;
    readonly body?: unknown;
    readonly message: string;
  }) => ProviderSourceErrorClassification | null | undefined;
}

export interface ProviderSourceInspectResult {
  readonly sourceId: string;
  readonly accountId?: string;
  readonly ready: boolean;
  readonly reason?: string;
  readonly baseUrl?: string;
  readonly protocol?: string;
  readonly modes?: readonly ProviderSourceMode[];
}

export interface ProviderSourceResolver {
  listReadyAccounts?(
    sourceId: string,
    signal?: AbortSignal,
  ): readonly string[] | Promise<readonly string[]>;
  inspectSync(
    sourceId: string,
    accountId?: string,
  ): ProviderSourceInspectResult | null;
  resolve(request: {
    readonly sourceId: string;
    readonly accountId?: string;
    readonly mode: ProviderSourceMode;
    readonly model: string;
    readonly declaredBaseUrl?: string;
    readonly signal?: AbortSignal;
  }): Promise<ProviderSourceAttemptContext>;
  refresh?(request: {
    readonly sourceId: string;
    readonly accountId?: string;
    readonly mode: ProviderSourceMode;
    readonly model: string;
    readonly failedGeneration?: number;
    readonly statusCode: number;
    readonly signal?: AbortSignal;
  }): Promise<ProviderSourceAttemptContext | null>;
}

/** Origin-level equality check. Unparseable or missing URLs return false. */
export function hasSameOrigin(
  url: string | undefined,
  trustedUrl: string | undefined,
): boolean {
  if (!url || !trustedUrl) return false;
  try {
    return new URL(url).origin === new URL(trustedUrl).origin;
  } catch {
    return false;
  }
}
