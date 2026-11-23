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

export interface ProviderSourceAttemptContext {
  readonly sourceId: string;
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
