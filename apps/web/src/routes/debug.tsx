import { createFileRoute } from "@tanstack/react-router";
import { Terminal, Activity, Database as DbIcon, GitMerge, FileJson } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/debug")({
  component: DebugPage,
});

function DebugPage() {
  return (
    <div className="flex h-[calc(100vh-8rem)] w-full flex-col border border-border">
      {/* Header */}
      <div className="flex-shrink-0 p-4 border-b border-border bg-background flex items-center justify-between">
        <h1 className="font-display font-bold text-xl flex items-center gap-2">
          <Terminal className="w-5 h-5" /> Subsystem Debugger
        </h1>
        <div className="flex gap-3">
          <Badge variant="outline" className="font-mono">DB: Postgres 17</Badge>
          <Badge variant="outline" className="font-mono text-green-600 border-green-600/30 bg-green-600/10">Connected</Badge>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <Tabs defaultValue="db" className="flex-1 flex flex-col w-full">
          <div className="flex-shrink-0 border-b border-border bg-muted/10 px-4 pt-4">
            <TabsList className="rounded-none bg-transparent gap-4 p-0">
              <TabsTrigger 
                value="db" 
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-2 py-3"
              >
                <DbIcon className="w-4 h-4 mr-2" /> Database Tables
              </TabsTrigger>
              <TabsTrigger 
                value="traces" 
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-2 py-3"
              >
                <Activity className="w-4 h-4 mr-2" /> Execution Traces
              </TabsTrigger>
              <TabsTrigger 
                value="prompts" 
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-2 py-3"
              >
                <FileJson className="w-4 h-4 mr-2" /> Live Prompts
              </TabsTrigger>
              <TabsTrigger 
                value="branches" 
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-2 py-3"
              >
                <GitMerge className="w-4 h-4 mr-2" /> Branch Management
              </TabsTrigger>
            </TabsList>
          </div>

          <ScrollArea className="flex-1 bg-muted/5">
            <TabsContent value="db" className="p-6 m-0 h-full">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-6xl mx-auto">
                {/* Mock Runs Table */}
                <Card>
                  <CardHeader className="border-b border-border py-4">
                    <CardTitle className="text-base flex items-center justify-between">
                      <span className="font-mono">table: runs</span>
                      <Badge variant="secondary">3 records</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="w-full overflow-x-auto">
                      <table className="w-full text-sm text-left">
                        <thead className="text-xs text-muted-foreground bg-muted/20 uppercase bg-gray-50 border-b border-border">
                          <tr>
                            <th className="px-4 py-3 font-medium">id</th>
                            <th className="px-4 py-3 font-medium">status</th>
                            <th className="px-4 py-3 font-medium">current_turn</th>
                          </tr>
                        </thead>
                        <tbody className="font-mono">
                          <tr className="border-b border-border">
                            <td className="px-4 py-3 text-primary">run_8f2a...</td>
                            <td className="px-4 py-3">active</td>
                            <td className="px-4 py-3">42</td>
                          </tr>
                          <tr className="border-b border-border text-muted-foreground">
                            <td className="px-4 py-3">run_3b1c...</td>
                            <td className="px-4 py-3">archived</td>
                            <td className="px-4 py-3">128</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>

                {/* Mock State Entries Table */}
                <Card>
                  <CardHeader className="border-b border-border py-4">
                    <CardTitle className="text-base flex items-center justify-between">
                      <span className="font-mono">table: state_entries</span>
                      <Badge variant="secondary">156 records</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="w-full overflow-x-auto">
                      <table className="w-full text-sm text-left">
                        <thead className="text-xs text-muted-foreground bg-muted/20 uppercase bg-gray-50 border-b border-border">
                          <tr>
                            <th className="px-4 py-3 font-medium">scope</th>
                            <th className="px-4 py-3 font-medium">key</th>
                            <th className="px-4 py-3 font-medium">value</th>
                          </tr>
                        </thead>
                        <tbody className="font-mono text-xs">
                          <tr className="border-b border-border">
                            <td className="px-4 py-3">world.actor</td>
                            <td className="px-4 py-3 text-primary">npc_goblin_1</td>
                            <td className="px-4 py-3 text-muted-foreground truncate max-w-[150px]">{"{ hp: 12, pos: [1,2] }"}</td>
                          </tr>
                          <tr className="border-b border-border">
                            <td className="px-4 py-3">player.inv</td>
                            <td className="px-4 py-3 text-primary">gold_coins</td>
                            <td className="px-4 py-3 text-muted-foreground truncate max-w-[150px]">450</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="prompts" className="p-6 m-0">
              <div className="max-w-4xl mx-auto space-y-6">
                <Card className="border-primary/20">
                  <CardHeader className="border-b border-border bg-muted/10 py-3">
                    <CardTitle className="text-sm font-mono flex items-center justify-between">
                      <span>Runtime: core-runtime</span>
                      <Badge>Latest Turn</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4 space-y-4 font-mono text-sm">
                    <div>
                      <div className="text-muted-foreground text-xs uppercase mb-2">System Prompt</div>
                      <div className="bg-background border border-border p-4 text-foreground whitespace-pre-wrap">
{`You are the core runtime for Covel AI RPG framework.
Your task is to progress the world state by 1 turn based on the player's action.
Evaluate rules from the loaded plugins (combat-engine, world-simulator).

Available Tools:
- get_location_details
- roll_perception
- emit_event
- patch_state`}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-xs uppercase mb-2">Compiled Context (State + Records)</div>
                      <div className="bg-background border border-border p-4 text-muted-foreground whitespace-pre-wrap">
{`[STATE] 
Location: Forbidden Forest (Danger 4)
Actors present: Elowen (Player)

[RECORDS]
Recent Lore: The Crimson Runes react aggressively to iron.`}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            {/* Other tabs left empty/minimal for mockup purposes */}
            <TabsContent value="traces" className="p-6 m-0 flex items-center justify-center h-full text-muted-foreground">
              Trace visualization dashboard will mount here.
            </TabsContent>
            <TabsContent value="branches" className="p-6 m-0 flex items-center justify-center h-full text-muted-foreground">
              Branch tree graph will mount here.
            </TabsContent>
          </ScrollArea>
        </Tabs>
      </div>
    </div>
  );
}
