/** A versioned projection of the JSON actually sent by a text protocol adapter. */
export interface LLMProviderRequest {
  readonly schemaVersion: 1;
  readonly provider: string;
  readonly protocol: string;
  readonly body: Readonly<Record<string, unknown>>;
  /** False when unsupported metadata or credential-bearing URLs were omitted. */
  readonly complete: boolean;
  readonly omittedFieldCount: number;
  readonly startedAt: string;
  readonly durationMs: number;
  /** Transport retry index within one protocol request, starting at zero. */
  readonly transportAttempt: number;
  /** HTTP acceptance is not a successful model/stream settlement. */
  readonly statusCode?: number;
  readonly failed?: true;
}
