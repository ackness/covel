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
import { ScrollArea } from "@/components/ui/scroll-area.js";
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
  traceDiscovery,
}: {
  selectedSessionId: string | null;
  snapshotData: DebugPageData["snapshotData"];
  traceDiscovery: DebugPageData["traceDiscovery"];
}) {
  const { t } = useTranslation();

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="p-4 max-w-5xl space-y-4">
        {!selectedSessionId && (
          <p className="text-sm text-muted-foreground py-20 text-center">
            {t("debugger.selectSession")}
          </p>
        )}
        {selectedSessionId && !snapshotData && (
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
                  turnCount: snapshotData.session.turnCount,
                  locale: snapshotData.session.locale,
                }}
              />
            </DataSection>

            <DataSection
              title={t("debugger.dataSection.frameworkCapabilities")}
              icon={<Shield className="w-3.5 h-3.5" />}
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
                      <Badge variant="outline" className="text-[9px]">
                        {character.type}
                      </Badge>
                    </div>
                    {character.description && (
                      <p className="text-[11px] text-muted-foreground">
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
            >
              {snapshotData.messages.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  {t("debugger.noMessages")}
                </p>
              ) : (
                snapshotData.messages.map((message) => (
                  <div
                    key={message.id}
                    className={`border p-2 text-[11px] ${
                      message.role === "user"
                        ? "border-blue-500/20 bg-blue-500/5"
                        : "border-border"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant="outline" className="text-[9px]">
                        {message.role}
                      </Badge>
                      {message.kind && (
                        <Badge variant="outline" className="text-[9px]">
                          {message.kind}
                        </Badge>
                      )}
                      {message.runtimeId && (
                        <span className="text-[9px] text-muted-foreground font-mono">
                          {message.runtimeId}
                        </span>
                      )}
                    </div>
                    {message.content ? (
                      <p className="text-muted-foreground whitespace-pre-wrap line-clamp-3">
                        {message.content}
                      </p>
                    ) : message.block ? (
                      <Badge variant="outline" className="text-[9px]">
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
            >
              {snapshotData.executionSteps.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  {t("debugger.noExecutionTraces")}
                </p>
              ) : (
                snapshotData.executionSteps.map((step, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-2 text-[11px] font-mono py-0.5"
                  >
                    <Badge variant="outline" className="text-[9px] shrink-0">
                      {step.type}
                    </Badge>
                    <span className="text-muted-foreground truncate">
                      {((step.payload as Record<string, unknown>)
                        ?.runtimeId as string) ?? step.turnId}
                    </span>
                    {(step.payload as Record<string, unknown>)?.durationMs !=
                      null && (
                      <span className="text-[9px] text-muted-foreground shrink-0">
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
    </ScrollArea>
  );
}
