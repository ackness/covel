export type AiProviderErrorCode =
	| "RATE_LIMITED"
	| "SCHEMA_VALIDATION_FAILED"
	| "PROVIDER_ERROR"
	| "CONFIG_ERROR";

export class AiProviderError extends Error {
	public readonly code: AiProviderErrorCode;
	public readonly provider: string;
	public readonly retriable: boolean;
	public readonly statusCode?: number;
	public readonly details?: Record<string, unknown>;

	constructor(options: {
		code: AiProviderErrorCode;
		message: string;
		provider: string;
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
		this.retriable = options.retriable;
		this.statusCode = options.statusCode;
		this.details = options.details;
	}
}
