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
  /** Transport attempt across all fallback targets/runtime retries, zero-based. */
  readonly logicalAttempt?: number;
  /**
   * Why this transport sent the request again: the prior response asked for
   * it, or the connection gave no response. Absent on the first send.
   * `http-4xx` is a retried client status other than 429 (408, 409, or one
   * the provider marked retryable).
   */
  readonly transportRetryReason?:
    "http-429" | "http-4xx" | "http-5xx" | "connection";
  /** HTTP acceptance is not a successful model/stream settlement. */
  readonly statusCode?: number;
  readonly failed?: true;
}
