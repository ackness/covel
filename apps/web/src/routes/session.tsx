import { createFileRoute } from "@tanstack/react-router";
import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Settings, Database, Cpu, MessageSquare, Map as MapIcon, BookOpen,
  Code, LayoutTemplate, Loader2, AlertCircle, KeyRound, Plus, Globe, Sparkles,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ImperativePanelHandle } from "react-resizable-panels";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useSession, type StreamMessage } from "@/stores/session-store";
import { SettingsDialog } from "@/components/settings-dialog";
import { getBlockRenderer } from "@/components/blocks/block-renderer";

export const Route = createFileRoute("/session")({
  component: SessionPage,
});

function SessionPage() {
  const { t } = useTranslation();
  const { state, initSession, sendMessage, resetSession } = useSession();
  const [viewMode, setViewMode] = useState<"parsed" | "raw">("parsed");
  const [inputValue, setInputValue] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const isMobile = useMediaQuery("(max-width: 768px)");
  const isTablet = useMediaQuery("(max-width: 1024px)");

  const leftPanelRef = useRef<ImperativePanelHandle>(null);
  const rightPanelRef = useRef<ImperativePanelHandle>(null);
  const [isLeftCollapsed, setIsLeftCollapsed] = useState(false);
  const [isRightCollapsed, setIsRightCollapsed] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages]);

  // Auto-collapse panels on smaller screens
  useEffect(() => {
    if (isMobile || isTablet) {
      if (leftPanelRef.current && !isLeftCollapsed) leftPanelRef.current.collapse();
      if (rightPanelRef.current && !isRightCollapsed) rightPanelRef.current.collapse();
    }
  }, [isMobile, isTablet]);

  const toggleLeftPanel = () => {
    const panel = leftPanelRef.current;
    if (panel) {
      if (isLeftCollapsed) panel.expand(); else panel.collapse();
    }
  };

  const toggleRightPanel = () => {
    const panel = rightPanelRef.current;
    if (panel) {
      if (isRightCollapsed) panel.expand(); else panel.collapse();
    }
  };

  const handleSubmit = useCallback(() => {
    const val = inputValue.trim();
    if (!val || state.executing) return;
    sendMessage(val);
    setInputValue("");
  }, [inputValue, state.executing, sendMessage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  const direction = isMobile ? "vertical" : "horizontal";

  // ── Left Panel: Config ─────────────────────────────────────────

  const LeftPanelContent = () => (
    <>
      <div className="h-14 px-3 border-b border-border bg-background flex items-center justify-between shrink-0">
        <h2 className="font-display font-bold text-sm uppercase tracking-widest flex items-center gap-2 whitespace-nowrap">
          <Settings className="w-4 h-4 shrink-0" />
          <span className={isLeftCollapsed ? "hidden" : "hidden sm:inline-block"}>
            {t("session.config", "Studio Config")}
          </span>
        </h2>
        <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm ml-2 shrink-0" onClick={toggleLeftPanel}>
          <Settings className="w-4 h-4" />
        </Button>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-4 space-y-6">
          {/* Session Status */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {t("session.status", "Session Status")}
            </h3>
            <Card>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full shrink-0 ${state.session ? "bg-green-500 animate-pulse" : "bg-muted-foreground"}`} />
                    <span className="text-sm font-medium truncate">
                      {state.session ? state.session.status : t("common.loading", "Loading...")}
                    </span>
                  </div>
                  {state.session && (
                    <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                      {state.session.id.slice(0, 12)}
                    </Badge>
                  )}
                </div>
                {state.session && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Phase:</span>
                    <Badge variant="secondary" className="text-[10px]">
                      {state.phase}
                    </Badge>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Active Presets */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {t("session.providers", "Active Providers")}
            </h3>
            <div className="grid gap-2">
              {state.presets.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No presets loaded</p>
              ) : (
                state.presets.filter((p) => p.enabled).map((preset) => (
                  <Card key={preset.id}>
                    <CardContent className="p-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Cpu className={`w-4 h-4 shrink-0 ${preset.isDefault ? "text-primary" : "text-muted-foreground"}`} />
                        <span className="text-sm font-medium truncate">{preset.name}</span>
                      </div>
                      <Badge variant={preset.isDefault ? "default" : "secondary"} className="shrink-0">
                        {preset.model}
                      </Badge>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          </div>

          {/* Loaded Plugins */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {t("session.plugins", "Loaded Plugins")}
            </h3>
            <div className="flex flex-wrap gap-2">
              {state.packages.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No plugins loaded</p>
              ) : (
                state.packages.filter((p) => p.enabled).map((pkg) => (
                  <Badge key={pkg.name} variant="outline" className="border-primary/20">
                    {pkg.name}
                  </Badge>
                ))
              )}
            </div>
          </div>

          {/* Available Commands */}
          {state.commands.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Commands
              </h3>
              <div className="grid gap-1.5">
                {state.commands.map((cmd) => (
                  <div key={cmd.name} className="text-xs border border-border px-3 py-2 flex items-center justify-between">
                    <span className="font-mono text-primary">/{cmd.name}</span>
                    <span className="text-muted-foreground truncate ml-2">{cmd.description}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="pt-4 space-y-2">
            <Button className="w-full rounded-none" variant="outline" onClick={() => setSettingsOpen(true)}>
              <KeyRound className="w-4 h-4 mr-2" />
              {t("nav.settings", "Settings")}
            </Button>
            {state.session && (
              <Button
                className="w-full rounded-none"
                variant="outline"
                onClick={() => resetSession()}
              >
                <Plus className="w-4 h-4 mr-2" />
                New Session
              </Button>
            )}
          </div>
        </div>
      </ScrollArea>
    </>
  );

  // ── Right Panel: State & World ─────────────────────────────────

  const RightPanelContent = () => (
    <Tabs defaultValue="state" className="flex-1 flex flex-col min-h-0 min-w-0">
      <div className="h-14 px-2 border-b border-border bg-background flex items-center justify-between shrink-0">
        <TabsList className="grid w-full grid-cols-3 rounded-none flex-1 max-w-[240px]">
          <TabsTrigger value="state" className="text-xs uppercase tracking-widest">{t("session.state", "State")}</TabsTrigger>
          <TabsTrigger value="world" className="text-xs uppercase tracking-widest">{t("session.world", "World")}</TabsTrigger>
          <TabsTrigger value="records" className="text-xs uppercase tracking-widest">{t("session.lore", "Lore")}</TabsTrigger>
        </TabsList>
        <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm shrink-0 ml-2" onClick={toggleRightPanel}>
          <Database className="w-4 h-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <TabsContent value="state" className="p-4 m-0 space-y-4">
          <h3 className="font-display font-semibold flex items-center gap-2 mb-4 text-sm uppercase tracking-widest whitespace-nowrap">
            <Database className="w-4 h-4 shrink-0" /> State Patches
          </h3>
          {state.statePatches.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No state changes yet. Send a message to begin.</p>
          ) : (
            state.statePatches.map((patch) => (
              <Card key={patch.id}>
                <CardContent className="p-4 text-xs space-y-1">
                  <span className="font-medium">{patch.summary}</span>
                  <Badge variant="outline" className="text-[10px] ml-2">{patch.packageName}</Badge>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>
        <TabsContent value="world" className="p-4 m-0">
          <h3 className="font-display font-semibold flex items-center gap-2 mb-4 text-sm uppercase tracking-widest whitespace-nowrap">
            <MapIcon className="w-4 h-4 shrink-0" /> World
          </h3>
          {state.world ? (
            <Card>
              <CardContent className="p-4 space-y-2">
                <span className="font-bold text-sm">{state.world.name}</span>
                <p className="text-muted-foreground text-xs">{state.world.description}</p>
                <span className="text-[10px] text-muted-foreground font-mono">{state.world.id}</span>
              </CardContent>
            </Card>
          ) : (
            <p className="text-xs text-muted-foreground italic">No world loaded.</p>
          )}
        </TabsContent>
        <TabsContent value="records" className="p-4 m-0">
          <h3 className="font-display font-semibold flex items-center gap-2 mb-4 text-sm uppercase tracking-widest whitespace-nowrap">
            <BookOpen className="w-4 h-4 shrink-0" /> Records
          </h3>
          <p className="text-xs text-muted-foreground italic">Long-term records will appear here as the story progresses.</p>
        </TabsContent>
      </ScrollArea>
    </Tabs>
  );

  // ── Message Rendering ──────────────────────────────────────────

  function renderMessage(msg: StreamMessage) {
    if (msg.block) {
      return renderBlock(msg);
    }

    const isUser = msg.role === "user";
    const isSystem = msg.role === "system";

    return (
      <div key={msg.id} className={`flex flex-col gap-1.5 ${isUser ? "items-end" : ""}`}>
        <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
          {isUser ? "Player" : isSystem ? "System" : "Assistant"}
          {msg.turnId && <span className="ml-2 font-mono text-[10px]">{msg.turnId}</span>}
        </span>
        {viewMode === "parsed" ? (
          <div
            className={`border border-border p-4 text-sm break-words max-w-[90%] md:max-w-[85%] ${
              isUser
                ? "bg-primary text-primary-foreground"
                : "bg-card prose prose-sm dark:prose-invert max-w-none"
            }`}
          >
            {msg.content.split("\n").map((line, i) => (
              <p key={i} className={i > 0 ? "mt-2" : ""}>{line}</p>
            ))}
          </div>
        ) : (
          <div className="border border-border p-4 bg-muted/10 text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all max-w-[90%] md:max-w-[85%]">
            {JSON.stringify({ role: msg.role, content: msg.content, turnId: msg.turnId }, null, 2)}
          </div>
        )}
      </div>
    );
  }

  function renderBlock(msg: StreamMessage) {
    const block = msg.block!;
    const blockType = block.type as string;
    const data = block.data as Record<string, unknown> | undefined;

    const Renderer = getBlockRenderer(blockType);

    return (
      <div key={msg.id} className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
          {block.interaction && (block.interaction as Record<string, unknown>).requiresResponse
            ? "Interactive Block"
            : `Block: ${blockType}`}
        </span>
        {viewMode === "parsed" && Renderer && data ? (
          <Renderer
            data={data}
            onSubmit={sendMessage}
            disabled={state.executing}
          />
        ) : (
          <div className="border border-border p-4 bg-muted/10 text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">
            {JSON.stringify(block, null, 2)}
          </div>
        )}
      </div>
    );
  }

  // ── Boot Error / Loading ───────────────────────────────────────

  if (state.bootError) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Card className="max-w-md w-full mx-4">
          <CardContent className="p-6 space-y-4 text-center">
            <AlertCircle className="w-8 h-8 text-destructive mx-auto" />
            <p className="text-sm font-medium">Failed to connect to server</p>
            <p className="text-xs text-muted-foreground break-all">{state.bootError}</p>
            <p className="text-xs text-muted-foreground">Make sure the server is running on port 3001.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── World Selection Screen ─────────────────────────────────────

  if (state.booted && !state.session) {
    return (
      <div className="flex h-full w-full overflow-hidden">
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        <ScrollArea className="w-full h-full">
          <div className="max-w-4xl mx-auto px-4 md:px-8 py-8 md:py-16">
            <div className="text-center mb-10 space-y-3">
              <h1 className="font-display font-bold text-2xl md:text-3xl uppercase tracking-widest flex items-center justify-center gap-3">
                <Globe className="w-6 h-6 md:w-8 md:h-8" />
                Select World
              </h1>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                Choose a world to begin your adventure. Each world has unique lore, characters, and narration style.
              </p>
              <Button variant="ghost" size="sm" className="text-xs uppercase tracking-widest" onClick={() => setSettingsOpen(true)}>
                <KeyRound className="w-3.5 h-3.5 mr-1.5" />
                Configure API Keys
              </Button>
            </div>

            <div className="grid gap-4 md:gap-6">
              {state.worlds.map((world) => (
                <Card
                  key={world.id}
                  className="cursor-pointer transition-all hover:border-primary/50 hover:shadow-md group"
                  onClick={() => initSession(world.id)}
                >
                  <CardContent className="p-5 md:p-6">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0 space-y-2">
                        <h2 className="font-display font-bold text-lg group-hover:text-primary transition-colors">
                          {world.name}
                        </h2>
                        <p className="text-sm text-muted-foreground">{world.description}</p>
                        {world.tags && world.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 pt-1">
                            {world.tags.map((tag) => (
                              <Badge key={tag} variant="outline" className="text-[10px]">{tag}</Badge>
                            ))}
                          </div>
                        )}
                      </div>
                      <Sparkles className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors shrink-0 mt-1" />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {state.worlds.length === 0 && (
              <div className="text-center py-12">
                <Loader2 className="w-5 h-5 animate-spin mx-auto text-muted-foreground" />
                <p className="text-sm text-muted-foreground mt-2">Loading worlds...</p>
              </div>
            )}

            {/* Info about loaded plugins & presets */}
            <div className="mt-10 pt-6 border-t border-border flex flex-wrap items-center justify-center gap-4 text-xs text-muted-foreground">
              {state.packages.filter((p) => p.enabled).length > 0 && (
                <span className="flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5" />
                  {state.packages.filter((p) => p.enabled).length} plugins loaded
                </span>
              )}
              {state.presets.length > 0 && (
                <span className="flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" />
                  {(state.presets.find((p) => p.isDefault) ?? state.presets[0])?.name ?? "No preset"}
                </span>
              )}
            </div>
          </div>
        </ScrollArea>
      </div>
    );
  }

  // ── Main Layout ────────────────────────────────────────────────

  return (
    <div className="flex h-full w-full overflow-hidden border-t border-border">
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      <ResizablePanelGroup direction={direction} className="w-full h-full">
        {/* Left Panel: Settings */}
        <ResizablePanel
          ref={leftPanelRef}
          defaultSize={isMobile ? 0 : 20}
          minSize={15}
          maxSize={isMobile ? 80 : 40}
          collapsible={true}
          collapsedSize={0}
          onCollapse={() => setIsLeftCollapsed(true)}
          onExpand={() => setIsLeftCollapsed(false)}
          className="bg-muted/10 flex flex-col min-h-0 min-w-0"
        >
          <LeftPanelContent />
        </ResizablePanel>

        <ResizableHandle withHandle className={isLeftCollapsed ? "hidden" : ""} />

        {/* Mobile: Right panel before center */}
        {isMobile && (
          <>
            <ResizablePanel
              ref={rightPanelRef}
              defaultSize={0}
              minSize={20}
              maxSize={80}
              collapsible={true}
              collapsedSize={0}
              onCollapse={() => setIsRightCollapsed(true)}
              onExpand={() => setIsRightCollapsed(false)}
              className="bg-muted/10 flex flex-col min-h-0 min-w-0"
            >
              <RightPanelContent />
            </ResizablePanel>
            <ResizableHandle withHandle className={isRightCollapsed ? "hidden" : ""} />
          </>
        )}

        {/* Center Panel: Execution Stream */}
        <ResizablePanel defaultSize={isMobile ? 100 : 55} minSize={isMobile ? 20 : 30} className="bg-background flex flex-col min-w-0 min-h-0">
          {/* Header */}
          <div className="h-14 px-3 border-b border-border flex justify-between items-center bg-background z-10 shrink-0">
            <div className="flex items-center gap-2 overflow-hidden">
              <Button
                variant="ghost"
                size="icon"
                className={`h-8 w-8 rounded-sm shrink-0 ${!isLeftCollapsed && "bg-accent text-accent-foreground"}`}
                onClick={toggleLeftPanel}
              >
                <Settings className="w-4 h-4" />
              </Button>
              <h2 className="font-display font-bold text-sm uppercase tracking-widest flex items-center gap-2 truncate ml-2">
                <MessageSquare className="w-4 h-4 shrink-0" />
                <span className="hidden sm:inline-block">{t("session.executionStream", "Execution Stream")}</span>
              </h2>
            </div>
            <div className="flex items-center gap-4 shrink-0">
              <div className="hidden sm:flex items-center border border-border rounded-md overflow-hidden">
                <Toggle
                  pressed={viewMode === "parsed"}
                  onPressedChange={() => setViewMode("parsed")}
                  size="sm"
                  className="rounded-none border-0 h-7 px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                >
                  <LayoutTemplate className="w-3.5 h-3.5 mr-1.5" />
                  <span className="text-xs">Parsed</span>
                </Toggle>
                <Toggle
                  pressed={viewMode === "raw"}
                  onPressedChange={() => setViewMode("raw")}
                  size="sm"
                  className="rounded-none border-0 h-7 px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                >
                  <Code className="w-3.5 h-3.5 mr-1.5" />
                  <span className="text-xs">Raw</span>
                </Toggle>
              </div>

              <div className="flex sm:hidden items-center border border-border rounded-md overflow-hidden">
                <Toggle
                  pressed={viewMode === "parsed"}
                  onPressedChange={() => setViewMode("parsed")}
                  size="sm"
                  className="rounded-none border-0 h-7 px-2 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                  aria-label="Parsed view"
                >
                  <LayoutTemplate className="w-3.5 h-3.5" />
                </Toggle>
                <Toggle
                  pressed={viewMode === "raw"}
                  onPressedChange={() => setViewMode("raw")}
                  size="sm"
                  className="rounded-none border-0 h-7 px-2 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                  aria-label="Raw view"
                >
                  <Code className="w-3.5 h-3.5" />
                </Toggle>
              </div>

              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-sm shrink-0"
                onClick={() => setSettingsOpen(true)}
                title="Settings"
              >
                <KeyRound className="w-4 h-4" />
              </Button>

              <Button
                variant="ghost"
                size="icon"
                className={`h-8 w-8 rounded-sm shrink-0 ${!isRightCollapsed && "bg-accent text-accent-foreground"}`}
                onClick={toggleRightPanel}
                title="Toggle State & World Context"
              >
                <Database className="w-4 h-4" />
              </Button>
            </div>
          </div>

          {/* Messages */}
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-4 md:p-6 space-y-6 md:space-y-8 max-w-4xl mx-auto w-full">
              {!state.session && (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                  <span className="ml-2 text-sm text-muted-foreground">Initializing session...</span>
                </div>
              )}

              {state.session && state.messages.length === 0 && !state.executing && (
                <div className="flex flex-col items-center justify-center py-12 text-center space-y-3">
                  <MessageSquare className="w-8 h-8 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">
                    {state.phase === "init" && "Preparing your adventure..."}
                    {state.phase === "character_creation" && "Creating your character..."}
                    {state.phase === "playing" && "Your adventure awaits. Type a message to continue."}
                    {state.phase === "ended" && "This session has ended."}
                  </p>
                </div>
              )}

              {state.messages.map(renderMessage)}

              {state.executing && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Thinking...</span>
                </div>
              )}

              {state.executionError && (
                <div className="flex items-start gap-2 border border-destructive/50 bg-destructive/5 p-4 text-sm">
                  <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium text-destructive">Error</p>
                    <p className="text-xs text-muted-foreground mt-1 break-all">{state.executionError}</p>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>

          {/* Input — only visible during playing phase */}
          {state.phase === "playing" && (
            <div className="p-3 md:p-4 border-t border-border bg-muted/5 shrink-0">
              <div className="flex gap-2 max-w-4xl mx-auto">
                <input
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={t("session.inputPlaceholder", "Enter action or command...")}
                  disabled={!state.session || state.executing}
                  className="flex-1 min-w-0 bg-background border border-border px-3 md:px-4 py-2 md:py-2.5 text-sm outline-none focus:ring-1 focus:ring-primary transition-all disabled:opacity-50"
                />
                <Button
                  onClick={handleSubmit}
                  disabled={!state.session || state.executing || !inputValue.trim()}
                  className="rounded-none px-4 md:px-8 uppercase tracking-widest font-semibold text-xs h-auto shrink-0"
                >
                  {state.executing ? <Loader2 className="w-4 h-4 animate-spin" /> : t("common.execute", "Execute")}
                </Button>
              </div>
            </div>
          )}

          {/* Ended phase indicator */}
          {state.phase === "ended" && (
            <div className="p-3 md:p-4 border-t border-border bg-muted/5 shrink-0">
              <p className="text-center text-sm text-muted-foreground">
                {t("session.ended", "This session has ended.")}
              </p>
            </div>
          )}
        </ResizablePanel>

        {/* Desktop: Right panel */}
        {!isMobile && (
          <>
            <ResizableHandle withHandle className={isRightCollapsed ? "hidden" : ""} />
            <ResizablePanel
              ref={rightPanelRef}
              defaultSize={25}
              minSize={20}
              maxSize={50}
              collapsible={true}
              collapsedSize={0}
              onCollapse={() => setIsRightCollapsed(true)}
              onExpand={() => setIsRightCollapsed(false)}
              className="bg-muted/10 flex flex-col min-h-0 min-w-0"
            >
              <RightPanelContent />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
}
