import type { ServiceGateway } from "./types.js";
import { createRecordQueryService } from "./record-query-service.js";
import { createTableService } from "./table-service.js";
import { createScriptHostService } from "./script-host-service.js";
import { createReferenceService } from "./reference-service.js";
import { createApprovalService } from "./approval-service.js";
import { createRuntimeSettingsService } from "./runtime-settings-service.js";
import { createTraceService } from "./trace-service.js";
import type { ToolGatewayService } from "./types.js";

export interface ServiceGatewayConfig {
  /** Plugin IDs that bypass approval checks. */
  whitelistedPlugins?: ReadonlySet<string>;
  /** Tool gateway (injected from plugin-manager since it depends on tool registry). */
  toolGateway?: ToolGatewayService;
}

/**
 * Create a complete ServiceGateway with all sub-services.
 */
export function createServiceGateway(config?: ServiceGatewayConfig): ServiceGateway & {
  /** Access the record store for publishing records. */
  readonly recordStore: ReturnType<typeof createRecordQueryService>;
  /** Access the table store for creating tables. */
  readonly tableStore: ReturnType<typeof createTableService>;
  /** Access the trace store for querying traces. */
  readonly traceStore: ReturnType<typeof createTraceService>;
} {
  const recordStore = createRecordQueryService();
  const tableStore = createTableService();
  const scriptHost = createScriptHostService();
  const references = createReferenceService();
  const approvals = createApprovalService(config?.whitelistedPlugins);
  const settings = createRuntimeSettingsService();
  const traceStore = createTraceService();

  // Tool gateway is injected (depends on plugin-manager)
  const tools: ToolGatewayService = config?.toolGateway ?? {
    async listAvailable() { return []; },
    async invoke() { return { success: false, output: null, error: "No tool gateway configured." }; },
  };

  const gateway: ServiceGateway = {
    records: recordStore,
    tables: tableStore,
    scripts: scriptHost,
    references,
    approvals,
    tools,
    settings,
    trace: traceStore,
  };

  return Object.assign(gateway, { recordStore, tableStore, traceStore });
}
