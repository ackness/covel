import { useTranslation } from "react-i18next";
import {
  Activity,
  Database,
  FileJson,
  Gamepad2,
  Layers,
  MessageSquare,
  Shield,
} from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import {
  DataSection,
  FrameworkDiscoveryPanel,
  JsonBlock,
  PluginContractsPanel,
  PluginDataIndexPanel,
} from "./-session-data-panels.js";
import type { DebugPageData } from "./-debug-page-data.js";

export function SessionDataView({
  selectedSessionId,
  snapshotData,
  snapshotLoading = false,
  snapshotError = false,
  snapshotUpdatedAt,
  traceDiscovery,
}: {
  selectedSessionId: string | null;
  snapshotData: DebugPageData["snapshotData"];
  snapshotLoading?: boolean;
  snapshotError?: boolean;
  snapshotUpdatedAt?: string | null;
  traceDiscovery: DebugPageData["traceDiscovery"];
}) {
  const { t } = useTranslation();

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="p-4 max-w-5xl space-y-4">
        {!selectedSessionId && (
          <p className="text-sm text-muted-foreground py-20 text-center">
            {t("debugger.selectSession")}
          </p>
        )}
        {snapshotError && (
          <p role="alert" className="text-sm text-destructive">
            {t("debugger.snapshotRefreshFailed", {
              defaultValue:
                "Could not refresh session data. Displayed data may be outdated; use Refresh to retry.",
            })}
          </p>
        )}
        {snapshotUpdatedAt && (
          <p className="text-xs text-muted-foreground" role="status">
            {t("debugger.snapshotUpdatedAt", {
              defaultValue: "Data updated at {{time}}",
              time: new Date(snapshotUpdatedAt).toLocaleTimeString(),
            })}
            {snapshotLoading && ` · ${t("debugger.loadingSessionData")}`}
          </p>
        )}
        {selectedSessionId && !snapshotData && !snapshotError && (
          <p className="text-sm text-muted-foreground py-20 text-center">
            {t("debugger.loadingSessionData")}
          </p>
        )}
        {snapshotData && (
          <>
            <DataSection
              title={t("debugger.dataSection.session")}
              icon={<Layers className="w-3.5 h-3.5" />}
            >
              <JsonBlock
                data={{
                  id: snapshotData.session.id,
                  worldId: snapshotData.session.worldId,
                  completedPlayerTurns:
                    snapshotData.session.completedPlayerTurns,
                  locale: snapshotData.session.locale,
                  phase: snapshotData.session.phase,
                  setupRuntimes: snapshotData.session.setupRuntimes,
                }}
              />
            </DataSection>

            <DataSection
              title={t("debugger.dataSection.frameworkCapabilities")}
              icon={<Shield className="w-3.5 h-3.5" />}
              defaultExpanded={false}
            >
              {traceDiscovery ? (
                <FrameworkDiscoveryPanel framework={traceDiscovery.framework} />
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  {t("debugger.noFrameworkCapabilities")}
                </p>
              )}
            </DataSection>

            <DataSection
              title={`${t("debugger.dataSection.pluginContracts")} (${traceDiscovery?.plugins.length ?? 0})`}
              icon={<FileJson className="w-3.5 h-3.5" />}
              defaultExpanded={false}
            >
              {traceDiscovery && traceDiscovery.plugins.length > 0 ? (
                <PluginContractsPanel plugins={traceDiscovery.plugins} />
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  {t("debugger.noPluginContracts")}
                </p>
              )}
            </DataSection>

            <DataSection
              title={`${t("debugger.dataSection.pluginDataIndex")} (${traceDiscovery?.pluginData.length ?? 0})`}
              icon={<Database className="w-3.5 h-3.5" />}
              defaultExpanded={false}
            >
              {traceDiscovery &&
              traceDiscovery.pluginData.some(
                (entry) => entry.namespaces.length > 0,
              ) ? (
                <PluginDataIndexPanel pluginData={traceDiscovery.pluginData} />
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  {t("debugger.noPluginDataIndex")}
                </p>
              )}
            </DataSection>

            <DataSection
              title={`${t("debugger.dataSection.characters")} (${snapshotData.characters.length})`}
              icon={<Gamepad2 className="w-3.5 h-3.5" />}
              defaultExpanded={false}
            >
              {snapshotData.characters.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  {t("debugger.noCharactersCreated")}
                </p>
              ) : (
                snapshotData.characters.map((character) => (
                  <div
                    key={character.id}
                    className="border border-border p-2 space-y-1"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold">
                        {character.name}
                      </span>
                      <Badge variant="outline" className="text-xs">
                        {character.type}
                      </Badge>
                    </div>
                    {character.description && (
                      <p className="text-xs text-muted-foreground">
                        {character.description}
                      </p>
                    )}
                    {character.fields && <JsonBlock data={character.fields} />}
                  </div>
                ))
              )}
            </DataSection>

            <DataSection
              title={`${t("debugger.dataSection.messages")} (${snapshotData.messages.length})`}
              icon={<MessageSquare className="w-3.5 h-3.5" />}
              defaultExpanded={false}
            >
              {snapshotData.messages.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  {t("debugger.noMessages")}
                </p>
              ) : (
                snapshotData.messages.map((message) => (
                  <div
                    key={message.id}
                    className={`debug-data-message border p-2 text-xs ${
                      message.role === "user"
                        ? "border-blue-500/20 bg-blue-500/5"
                        : "border-border"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant="outline" className="text-xs">
                        {message.role}
                      </Badge>
                      {message.kind && (
                        <Badge variant="outline" className="text-xs">
                          {message.kind}
                        </Badge>
                      )}
                      {message.runtimeId && (
                        <span className="text-xs text-muted-foreground font-mono">
                          {message.runtimeId}
                        </span>
                      )}
                    </div>
                    {message.content ? (
                      <p className="text-muted-foreground whitespace-pre-wrap line-clamp-3">
                        {message.content}
                      </p>
                    ) : message.block ? (
                      <Badge variant="outline" className="text-xs">
                        {t("debugger.blockType")}:{" "}
                        {
                          (message.block as Record<string, unknown>)
                            .type as string
                        }
                      </Badge>
                    ) : null}
                  </div>
                ))
              )}
            </DataSection>

            <DataSection
              title={t("debugger.dataSection.gameState")}
              icon={<Database className="w-3.5 h-3.5" />}
              defaultExpanded={false}
            >
              {Object.keys(snapshotData.gameState).length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  {t("debugger.noStateData")}
                </p>
              ) : (
                <JsonBlock data={snapshotData.gameState} />
              )}
            </DataSection>

            <DataSection
              title={`${t("debugger.dataSection.executionSteps")} (${snapshotData.executionSteps.length})`}
              icon={<Activity className="w-3.5 h-3.5" />}
              defaultExpanded={false}
            >
              {snapshotData.executionSteps.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  {t("debugger.noExecutionTraces")}
                </p>
              ) : (
                snapshotData.executionSteps.map((step, index) => (
                  <div
                    key={index}
                    className="debug-compact-row flex items-center gap-2 text-xs font-mono py-0.5"
                  >
                    <Badge variant="outline" className="text-xs shrink-0">
                      {step.type}
                    </Badge>
                    <span className="text-muted-foreground truncate">
                      {((step.payload as Record<string, unknown>)
                        ?.runtimeId as string) ?? step.turnId}
                    </span>
                    {(step.payload as Record<string, unknown>)?.durationMs !=
                      null && (
                      <span className="text-xs text-muted-foreground shrink-0">
                        {
                          (step.payload as Record<string, unknown>)
                            .durationMs as number
                        }
                        ms
                      </span>
                    )}
                  </div>
                ))
              )}
            </DataSection>
          </>
        )}
      </div>
    </div>
  );
}
