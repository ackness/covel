/** Shared HTTP/SSE transport contracts used by both server and web clients. */

export interface ApiErrorResponse<Code extends string = string> {
  readonly error: string;
  readonly code?: Code;
  readonly details?: unknown;
}

/** Standard envelope for a collection, optionally with an opaque page cursor. */
export interface ApiListResponse<T, Cursor = unknown> {
  readonly items: readonly T[];
  readonly nextCursor?: Cursor | null;
}

/** Standard acknowledgement for a command that does not return a resource. */
export type ApiOkResponse<
  Details extends Readonly<Record<string, unknown>> = Readonly<
    Record<never, never>
  >,
> = Readonly<{ ok: true } & Details>;

interface ActionRequestBase {
  readonly requestId: string;
  readonly sessionId: string;
  readonly locale?: string;
  readonly model?: string;
}

export type ActionRequest = {
  readonly payload: { readonly recoverFromTurnId?: string };
} & (
  | (ActionRequestBase & {
      readonly type: "send_message";
      readonly payload: { readonly content: string };
    })
  | (ActionRequestBase & {
      readonly type: "execute_command";
      readonly payload: { readonly command: string };
    })
  | (ActionRequestBase & {
      readonly type: "start_session";
      readonly payload: { readonly loreOverride?: string };
    })
  | (ActionRequestBase & {
      readonly type: "retry_runtime";
      readonly payload: {
        readonly runtimeId: string;
        readonly retryFromTurnId?: string;
      };
    })
  | (ActionRequestBase & {
      readonly type: "retry_turn";
      readonly payload: Readonly<Record<never, never>>;
    })
);

export type ActionType = ActionRequest["type"];

/** Shape accepted at an untrusted boundary before schema validation. */
export interface UntrustedActionRequest extends ActionRequestBase {
  readonly type: ActionType;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type ValidatedActionRequest = ActionRequest;

export type ActionRequestValidation =
  | { readonly ok: true; readonly value: ActionRequest }
  | { readonly ok: false; readonly error: string };

/** Envelope emitted by the turn-execution SSE stream. */
export interface SseEnvelope {
  readonly type: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly flowId: string;
  readonly seq: number;
  readonly timestamp: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface WorldCreateRequest {
  /** Omit to let the server mint an id; a supplied id must not already exist. */
  readonly id?: string;
  readonly name: string;
  readonly description?: string;
  readonly lore?: string;
  readonly tags?: readonly string[];
  readonly locale?: string;
  readonly dimensions?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt?: string;
}

export type WorldPatchRequest = Partial<
  Pick<
    WorldCreateRequest,
    | "name"
    | "description"
    | "lore"
    | "tags"
    | "locale"
    | "dimensions"
    | "metadata"
  >
>;

/** Public view of an unresolved runtime suspension. */
export interface SuspensionSummary {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly runtimeId: string;
  readonly pluginId: string;
  readonly reason?: string;
  readonly resumeSchema?: unknown;
  readonly createdAt: string;
}
