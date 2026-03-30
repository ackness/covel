import { createFileRoute } from "@tanstack/react-router";
import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Settings, Database, Cpu, MessageSquare, Map as MapIcon, BookOpen, Code, LayoutTemplate } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ImperativePanelHandle } from "react-resizable-panels";
import { useMediaQuery } from "@/hooks/use-media-query";

export const Route = createFileRoute("/session")({
  component: SessionPage,
});

function SessionPage() {
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<"parsed" | "raw">("parsed");
  
  const isMobile = useMediaQuery("(max-width: 768px)");
  const isTablet = useMediaQuery("(max-width: 1024px)");
  
  const leftPanelRef = useRef<ImperativePanelHandle>(null);
  const rightPanelRef = useRef<ImperativePanelHandle>(null);
  const [isLeftCollapsed, setIsLeftCollapsed] = useState(false);
  const [isRightCollapsed, setIsRightCollapsed] = useState(false);

  // Auto-collapse panels on smaller screens
  useEffect(() => {
    if (isMobile || isTablet) {
      const left = leftPanelRef.current;
      const right = rightPanelRef.current;
      
      if (left && !isLeftCollapsed) {
        left.collapse();
      }
      if (right && !isRightCollapsed) {
        right.collapse();
      }
    }
  }, [isMobile, isTablet]);

  const toggleLeftPanel = () => {
    const panel = leftPanelRef.current;
    if (panel) {
      if (isLeftCollapsed) {
        panel.expand();
      } else {
        panel.collapse();
      }
    }
  };

  const toggleRightPanel = () => {
    const panel = rightPanelRef.current;
    if (panel) {
      if (isRightCollapsed) {
        panel.expand();
      } else {
        panel.collapse();
      }
    }
  };

  const direction = isMobile ? "vertical" : "horizontal";

  // Reusable panel contents to avoid duplication
  const LeftPanelContent = () => (
    <>
      <div className="h-14 px-3 border-b border-border bg-background flex items-center justify-between shrink-0">
        <h2 className="font-display font-bold text-sm uppercase tracking-widest flex items-center gap-2 whitespace-nowrap">
          <Settings className="w-4 h-4 shrink-0" /> 
          <span className={isLeftCollapsed ? 'hidden' : 'hidden sm:inline-block'}>
            {t("session.config", "Studio Config")}
          </span>
        </h2>
        <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm ml-2 shrink-0" onClick={toggleLeftPanel} title="Toggle Configuration">
          <Settings className="w-4 h-4" />
        </Button>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-4 space-y-6">
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{t("session.status", "Session Status")}</h3>
            <Card>
              <CardContent className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0"></div>
                  <span className="text-sm font-medium truncate">Active (Turn 42)</span>
                </div>
                <Badge variant="outline" className="shrink-0">Run #8f2a</Badge>
              </CardContent>
            </Card>
          </div>
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{t("session.providers", "Active Providers")}</h3>
            <div className="grid gap-2">
              <Card>
                <CardContent className="p-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-primary shrink-0" />
                    <span className="text-sm font-medium truncate">Main LLM</span>
                  </div>
                  <Badge className="shrink-0">GPT-4o</Badge>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="text-sm font-medium truncate">Embedding</span>
                  </div>
                  <Badge variant="secondary" className="shrink-0">text-embedding-3</Badge>
                </CardContent>
              </Card>
            </div>
          </div>
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{t("session.plugins", "Loaded Plugins")}</h3>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className="border-primary/20">core-runtime</Badge>
              <Badge variant="outline" className="border-primary/20">world-simulator</Badge>
              <Badge variant="outline" className="border-primary/20">combat-engine</Badge>
            </div>
          </div>
          <div className="pt-4">
            <Button className="w-full rounded-none" variant="outline">{t("session.editConfig", "Edit Configuration")}</Button>
          </div>
        </div>
      </ScrollArea>
    </>
  );

  const RightPanelContent = () => (
    <Tabs defaultValue="state" className="flex-1 flex flex-col min-h-0 min-w-0">
      <div className="h-14 px-2 border-b border-border bg-background flex items-center justify-between shrink-0">
        <TabsList className="grid w-full grid-cols-3 rounded-none flex-1 max-w-[240px]">
          <TabsTrigger value="state" className="text-xs uppercase tracking-widest">{t("session.state", "State")}</TabsTrigger>
          <TabsTrigger value="world" className="text-xs uppercase tracking-widest">{t("session.world", "World")}</TabsTrigger>
          <TabsTrigger value="records" className="text-xs uppercase tracking-widest">{t("session.lore", "Lore")}</TabsTrigger>
        </TabsList>
        <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm shrink-0 ml-2" onClick={toggleRightPanel} title="Toggle State & World Context">
          <Database className="w-4 h-4" />
        </Button>
      </div>
      
      <ScrollArea className="flex-1 min-h-0">
        <TabsContent value="state" className="p-4 m-0 space-y-4">
          <h3 className="font-display font-semibold flex items-center gap-2 mb-4 text-sm uppercase tracking-widest whitespace-nowrap">
            <Database className="w-4 h-4 shrink-0" /> Current State
          </h3>
          <Card>
            <CardHeader className="py-3 px-4 border-b border-border bg-muted/5">
              <CardTitle className="text-xs uppercase tracking-wider truncate">Location</CardTitle>
            </CardHeader>
            <CardContent className="p-4 text-xs font-mono text-muted-foreground bg-background break-all">
              {`{\n  "id": "loc_forest_01",\n  "name": "Forbidden Forest",\n  "dangerLevel": 4\n}`}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="py-3 px-4 border-b border-border bg-muted/5">
              <CardTitle className="text-xs uppercase tracking-wider truncate">Inventory (Elowen)</CardTitle>
            </CardHeader>
            <CardContent className="p-4 text-sm flex flex-col gap-3 bg-background">
              <div className="flex justify-between items-center border-b border-border/50 pb-2 gap-2">
                <span className="font-medium truncate">Iron Sword</span>
                <Badge variant="secondary" className="text-[10px] shrink-0">Equipped</Badge>
              </div>
              <div className="flex justify-between items-center border-b border-border/50 pb-2 gap-2">
                <span className="truncate">Healing Potion</span>
                <span className="text-muted-foreground font-mono shrink-0">x3</span>
              </div>
              <div className="flex justify-between items-center gap-2">
                <span className="truncate">Rune Fragment</span>
                <span className="text-muted-foreground font-mono shrink-0">x1</span>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="world" className="p-4 m-0">
          <h3 className="font-display font-semibold flex items-center gap-2 mb-4 text-sm uppercase tracking-widest whitespace-nowrap">
            <MapIcon className="w-4 h-4 shrink-0" /> World Context
          </h3>
          <div className="text-sm text-muted-foreground border-l-2 border-primary pl-4 py-1 italic bg-background p-4 border-y border-r border-border/50 break-words">
            Active world snapshot containing immediate surrounding entities and rules.
          </div>
        </TabsContent>
        <TabsContent value="records" className="p-4 m-0">
          <h3 className="font-display font-semibold flex items-center gap-2 mb-4 text-sm uppercase tracking-widest whitespace-nowrap">
            <BookOpen className="w-4 h-4 shrink-0" /> Long-term Records
          </h3>
          <div className="space-y-3">
            <Card className="bg-background">
              <CardContent className="p-4 space-y-2">
                <span className="font-bold text-sm block truncate">The Crimson Runes</span>
                <p className="text-muted-foreground text-xs leading-relaxed break-words">Ancient artifacts left by the first magi. They react aggressively to the presence of iron, emitting a low hum and static charge.</p>
                <div className="pt-2 flex flex-wrap gap-2">
                  <Badge variant="outline" className="text-[10px]">lore</Badge>
                  <Badge variant="outline" className="text-[10px]">magic_item</Badge>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </ScrollArea>
    </Tabs>
  );

  return (
    <div className="flex h-full w-full overflow-hidden border-t border-border">
      <ResizablePanelGroup direction={direction} className="w-full h-full">
        
        {/* Panel 1: Settings (Left on Desktop, Top on Mobile) */}
        <ResizablePanel 
          ref={leftPanelRef}
          defaultSize={isMobile ? 0 : 20} 
          minSize={15} 
          maxSize={isMobile ? 80 : 40} 
          collapsible={true}
          collapsedSize={0}
          onCollapse={() => setIsLeftCollapsed(true)}
          onExpand={() => setIsLeftCollapsed(false)}
          className={`bg-muted/10 flex flex-col min-h-0 min-w-0`}
        >
          <LeftPanelContent />
        </ResizablePanel>

        <ResizableHandle withHandle className={isLeftCollapsed ? 'hidden' : ''} />

        {/* Panel 2: State Context (Middle on Mobile, Right on Desktop - controlled via flex order) */}
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
              className={`bg-muted/10 flex flex-col min-h-0 min-w-0`}
            >
              <RightPanelContent />
            </ResizablePanel>
            <ResizableHandle withHandle className={isRightCollapsed ? 'hidden' : ''} />
          </>
        )}

        {/* Panel 3: Execution Stream (Center on Desktop, Bottom on Mobile) */}
        <ResizablePanel defaultSize={isMobile ? 100 : 55} minSize={isMobile ? 20 : 30} className="bg-background flex flex-col min-w-0 min-h-0">
          <div className="h-14 px-3 border-b border-border flex justify-between items-center bg-background z-10 shrink-0">
            <div className="flex items-center gap-2 overflow-hidden">
              <Button 
                variant="ghost"
                size="icon" 
                className={`h-8 w-8 rounded-sm shrink-0 ${!isLeftCollapsed && 'bg-accent text-accent-foreground'}`} 
                onClick={toggleLeftPanel}
                title="Toggle Configuration"
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
              
              {/* Mobile toggle dropdown/select simplified version for tight space */}
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

              <Badge variant="secondary" className="rounded-none hidden md:inline-flex">Branch: default</Badge>
              
              <Button 
                variant="ghost"
                size="icon" 
                className={`h-8 w-8 rounded-sm shrink-0 ${!isRightCollapsed && 'bg-accent text-accent-foreground'}`} 
                onClick={toggleRightPanel}
                title="Toggle State & World Context"
              >
                <Database className="w-4 h-4" />
              </Button>
            </div>
          </div>
          
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-4 md:p-6 space-y-6 md:space-y-8 max-w-4xl mx-auto w-full">
              {/* Mock System Event */}
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">System • Turn 41</span>
                {viewMode === "parsed" ? (
                  <div className="border border-border p-4 bg-muted/20 text-sm break-words">
                    <span className="text-primary font-medium">[State Patch]</span> Character "Elowen" moved to Location "Forbidden Forest".
                  </div>
                ) : (
                  <div className="border border-border p-4 bg-muted/10 text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">
{`{\n  "type": "state.patch",\n  "scope": "world.actor",\n  "key": "elowen",\n  "patch": {\n    "locationId": "loc_forest_01"\n  }\n}`}
                  </div>
                )}
              </div>

              {/* Mock User Action */}
              <div className="flex flex-col gap-1.5 items-end">
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Player</span>
                {viewMode === "parsed" ? (
                  <div className="border border-border bg-primary text-primary-foreground p-4 text-sm max-w-[90%] md:max-w-[85%] break-words">
                    I carefully approach the glowing runestone, keeping my sword drawn.
                  </div>
                ) : (
                  <div className="border border-border bg-muted/10 text-xs font-mono text-muted-foreground p-4 max-w-[90%] md:max-w-[85%] whitespace-pre-wrap text-left w-full break-all">
{`{\n  "type": "event.emit",\n  "event": "player.action",\n  "payload": {\n    "intent": "approach runestone",\n    "stance": "cautious",\n    "equipment": ["iron_sword"]\n  }\n}`}
                  </div>
                )}
              </div>

              {/* Mock LLM Response */}
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Runtime / Main LLM</span>
                {viewMode === "parsed" ? (
                  <>
                    <div className="border border-border p-4 md:p-5 text-sm leading-relaxed prose prose-sm dark:prose-invert max-w-none bg-card break-words">
                      <p>As you step closer, the runestone's light shifts from a cold blue to an angry crimson. The air around it crackles with static magic, making the hair on your arms stand up.</p>
                      <p>A low hum begins to vibrate through the soles of your boots, and the shadows at the edge of the clearing seem to twist and elongate toward you.</p>
                    </div>
                    <div className="flex flex-wrap gap-2 mt-2">
                      <Badge variant="outline" className="text-[10px] font-mono">tool_call: get_location_details</Badge>
                      <Badge variant="outline" className="text-[10px] font-mono">tool_call: roll_perception</Badge>
                    </div>
                  </>
                ) : (
                  <div className="border border-border p-4 bg-muted/10 text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">
{`{\n  "role": "assistant",\n  "content": "As you step closer, the runestone's light shifts from a cold blue to an angry crimson. The air around it crackles with static magic, making the hair on your arms stand up.\\n\\nA low hum begins to vibrate through the soles of your boots, and the shadows at the edge of the clearing seem to twist and elongate toward you.",\n  "tool_calls": [\n    {\n      "id": "call_abc123",\n      "type": "function",\n      "function": {\n        "name": "get_location_details",\n        "arguments": "{\\"locationId\\":\\"loc_forest_01\\"}"\n      }\n    },\n    {\n      "id": "call_def456",\n      "type": "function",\n      "function": {\n        "name": "roll_perception",\n        "arguments": "{\\"actorId\\":\\"elowen\\",\\"difficulty\\":12}"\n      }\n    }\n  ]\n}`}
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>
          
          <div className="p-3 md:p-4 border-t border-border bg-muted/5 shrink-0">
            <div className="flex gap-2 max-w-4xl mx-auto">
              <input 
                type="text" 
                placeholder={t("session.inputPlaceholder", "Enter action or command...")}
                className="flex-1 min-w-0 bg-background border border-border px-3 md:px-4 py-2 md:py-2.5 text-sm outline-none focus:ring-1 focus:ring-primary transition-all"
              />
              <Button className="rounded-none px-4 md:px-8 uppercase tracking-widest font-semibold text-xs h-auto shrink-0">
                {t("common.confirm", "Execute")}
              </Button>
            </div>
          </div>
        </ResizablePanel>

        {!isMobile && (
          <>
            <ResizableHandle withHandle className={isRightCollapsed ? 'hidden' : ''} />
            <ResizablePanel 
              ref={rightPanelRef}
              defaultSize={25} 
              minSize={20} 
              maxSize={50} 
              collapsible={true}
              collapsedSize={0}
              onCollapse={() => setIsRightCollapsed(true)}
              onExpand={() => setIsRightCollapsed(false)}
              className={`bg-muted/10 flex flex-col min-h-0 min-w-0`}
            >
              <RightPanelContent />
            </ResizablePanel>
          </>
        )}

      </ResizablePanelGroup>
    </div>
  );
}
