import { useEffect, useMemo, useState } from "react";
import { fetchUiSpecs, type UISlotEntry } from "@/services/api.js";
import { useSessionStore, setComposerText, sendMessage, upsertPendingInteractionDraft } from "@/stores/session-store.js";
import { PluginPanel } from "@/components/panels/plugin-panel.js";

export function MessagePluginSurface() {
  const { session } = useSessionStore();
  const sessionId = session?.id;
  const [entries, setEntries] = useState<UISlotEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!sessionId) {
      setEntries([]);
      return;
    }

    fetchUiSpecs(sessionId)
      .then((specs) => {
        if (!cancelled) setEntries(specs.message);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const handlers = useMemo(
    () => ({
      draftMessage: async (params: Record<string, unknown>) => {
        const text = String(params.text ?? "").trim();
        if (!text) return;
        upsertPendingInteractionDraft({
          id: `plugin-draft:${text}`,
          turnId: session?.id ?? "plugin",
          interactionId: `plugin-draft:${text}`,
          type: "suggestion",
          label: text,
          values: { text },
        });
      },
      sendMessage: async (params: Record<string, unknown>) => {
        const text = String(params.text ?? "").trim();
        if (!text) return;
        await sendMessage(text);
      },
      setComposerText: async (params: Record<string, unknown>) => {
        setComposerText(String(params.text ?? ""));
      },
    }),
    [session?.id],
  );

  if (!sessionId || entries.length === 0) return null;

  return (
    <div className="space-y-4">
      {entries.flatMap((entry) =>
        entry.specs.map((spec, index) => (
          <PluginPanel
            key={`${entry.pluginId}:${index}`}
            pluginId={entry.pluginId}
            spec={spec}
            handlers={handlers}
          />
        )),
      )}
    </div>
  );
}
