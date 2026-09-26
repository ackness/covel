/** Session-owner diagnostics. Values and executable registrations are excluded. */
export interface PluginDiagnostic {
  readonly pluginId: string;
  readonly source: "builtin" | "community";
  readonly state:
    | "ready"
    | "inactive"
    | "approval-required"
    | "entry-pending"
    | "activation-error"
    | "load-error";
  readonly active: boolean;
  readonly runtimeIds: readonly string[];
  /** Only registrations currently available to this approved, active session. */
  readonly registrations: {
    readonly tools: readonly string[];
    readonly hooks: readonly { readonly id: string; readonly event: string }[];
    readonly actions: readonly string[];
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
  /** A bounded process-local window, cleared on server restart. */
  readonly history: { readonly scope: "process"; readonly limit: number };
}
