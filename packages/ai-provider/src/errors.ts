export type AiProviderErrorCode =
  | "REFUSAL"
  | "REQUEST_BUDGET_EXCEEDED"
  | "RATE_LIMITED"
  | "SCHEMA_VALIDATION_FAILED"
  | "PROVIDER_ERROR"
  | "CONFIG_ERROR";

/** A known invalid model binding/configuration, distinct from unexpected failures. */
export class ModelConfigurationError extends Error {}

export class AiProviderError extends Error {
  public readonly code: AiProviderErrorCode;
  public readonly provider: string;
  public readonly model?: string;
  public readonly retriable: boolean;
  public readonly statusCode?: number;
  public readonly details?: Record<string, unknown>;

  constructor(options: {
    code: AiProviderErrorCode;
    message: string;
    provider: string;
    model?: string;
    retriable: boolean;
    statusCode?: number;
    details?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(
      options.message,
      options.cause ? { cause: options.cause } : undefined,
    );
    this.name = "AiProviderError";
    this.code = options.code;
    this.provider = options.provider;
    this.model = options.model;
    this.retriable = options.retriable;
    this.statusCode = options.statusCode;
    this.details = options.details;
  }
}

/** A model endpoint has no base URL, or one the outbound policy does not allow. */
export class ProviderBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderBaseUrlError";
  }
}

/** The outbound guard refused a host: its DNS answer is empty or not allowed. */
export class SsrfPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfPolicyError";
  }
}

/**
 * The platform `fetch` got no response: the connection could not be made or
 * was lost. `code` is the transport's own code (`ECONNREFUSED`, …) when the
 * cause chain names one.
 */
export class OutboundFetchError extends Error {
  readonly code?: string;

  constructor(message: string, options: { cause: unknown; code?: string }) {
    super(message, { cause: options.cause });
    this.name = "OutboundFetchError";
    if (options.code) this.code = options.code;
  }
}

/** A wire ID of this kind is taken. */
export class WireAlreadyRegisteredError extends Error {
  readonly kind: string;
  readonly wireId: string;

  constructor(kind: string, wireId: string) {
    super(`${kind} wire "${wireId}" already registered`);
    this.name = "WireAlreadyRegisteredError";
    this.kind = kind;
    this.wireId = wireId;
  }
}
