import type { SessionPlugin } from "./plugin-api.js";

/** Session-owner diagnostics. Values and executable registrations are excluded. */
export interface PluginDiagnostic extends Pick<
  SessionPlugin,
  | "source"
  | "hostState"
  | "sessionState"
  | "serverCodeApproved"
  | "active"
  | "autoAdded"
  | "rejection"
  | "approvalRequired"
  | "error"
  | "registrationError"
> {
  readonly pluginId: string;
  readonly runtimeIds: readonly string[];
  /** Only registrations currently available to this approved, active session. */
  readonly registrations: {
    readonly tools: readonly string[];
    readonly hooks: readonly { readonly id: string; readonly event: string }[];
    readonly actions: readonly string[];
    readonly extensions?: readonly {
      readonly point: string;
      readonly id: string;
      readonly order?: number;
      readonly slot?: string;
    }[];
    readonly services: readonly {
      readonly name: string;
      readonly contract: string;
    }[];
  };
  readonly commands: readonly {
    readonly name: string;
    readonly action: string;
    readonly registered: boolean;
  }[];
}

/** Completed calls only; never includes inputs, outputs, or raw error messages. */
export interface PluginServiceCallDiagnostic {
  readonly extension?: {
    readonly point: string;
    readonly id: string;
    readonly slot?: string;
  };
  readonly callId: string;
  readonly parentCallId?: string;
  readonly turnId?: string;
  readonly runtimeId?: string;
  readonly callerPluginId: string;
  readonly providerPluginId: string;
  readonly name: string;
  readonly contract: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly outcome: "success" | "timeout" | "cancelled" | "error";
  readonly errorCode?: string;
}

export interface PluginDiagnosticsSnapshot {
  readonly sessionId: string;
  readonly capturedAt: string;
  readonly plugins: readonly PluginDiagnostic[];
  readonly calls: readonly PluginServiceCallDiagnostic[];
  /** Counts from exactly the returned calls window, not lifetime totals. */
  readonly extensionCalls: readonly {
    readonly point: string;
    readonly providerPluginId: string;
    readonly total: number;
    readonly success: number;
    readonly error: number;
    readonly timeout: number;
    readonly cancelled: number;
  }[];
  /** A bounded process-local window, cleared on server restart. */
  readonly history: { readonly scope: "process"; readonly limit: number };
}
