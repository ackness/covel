export type ModelGatewayErrorCode =
  | "RATE_LIMITED"
  | "SCHEMA_VALIDATION_FAILED"
  | "PROVIDER_ERROR";

export class ModelGatewayError extends Error {
  public readonly code: ModelGatewayErrorCode;
  public readonly provider: string;
  public readonly retriable: boolean;
  public readonly statusCode?: number;
  public readonly details?: Record<string, unknown>;

  public constructor(options: {
    code: ModelGatewayErrorCode;
    message: string;
    provider: string;
    retriable: boolean;
    statusCode?: number;
    details?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(options.message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ModelGatewayError";
    this.code = options.code;
    this.provider = options.provider;
    this.retriable = options.retriable;
    this.statusCode = options.statusCode;
    this.details = options.details;
  }
}
