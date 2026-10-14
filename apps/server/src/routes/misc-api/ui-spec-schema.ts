/**
 * Diagnostics of `/api/ui-specs`: one per declared UI spec the host does not
 * show. The rules themselves live in `@covel/shared` (`pluginUiSpecIssues`)
 * and are applied by the loader (`loadPluginUiSpecs`), the same rules
 * `pnpm validate:plugin` and installation use.
 */
import type { UiSlotName } from "./shared.js";

export interface UiSpecIssue {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

export interface UiSpecDiagnostic {
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly slot: UiSlotName;
  readonly specIndex: number;
  readonly specId?: string;
  readonly issues: readonly UiSpecIssue[];
}
