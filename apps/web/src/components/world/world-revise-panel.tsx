import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Wand2 } from "lucide-react";
import { worldEditionLocales, type WorldGenerationPart } from "@covel/shared";
import { Button } from "@/components/ui/button.js";
import * as api from "@/services/api.js";
import type { GenerateWorldError, WorldRecord } from "@/services/api.js";
import { getDataService, getStorageMode } from "@/services/data-service.js";
import {
  WorldGenerationStatus,
  type WorldGenerationPhase,
} from "./world-generation-status.js";

/**
 * A world that the generator made, wherever it is kept: files on the server,
 * a store, or this browser. Any other world package is changed in its files.
 */
export function isWorldRevisable(world: WorldRecord): boolean {
  return world.metadata?.generated === true;
}

const MAX_LENGTH = 2000;

interface WorldRevisePanelProps {
  world: WorldRecord;
  onRevised: (world: WorldRecord) => void;
}

/**
 * Change a generated world with a request in the player's words: "make it
 * three factions", "add a rival". The model rewrites only the part the
 * request concerns, and the result passes the same checks as a new world.
 */
export function WorldRevisePanel({ world, onRevised }: WorldRevisePanelProps) {
  const { t } = useTranslation();
  const [instruction, setInstruction] = useState("");
  const [phase, setPhase] = useState<WorldGenerationPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<GenerateWorldError["code"]>();
  const [parts, setParts] = useState<readonly WorldGenerationPart[]>([]);
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);

  useEffect(
    () => () => {
      runRef.current += 1;
      abortRef.current?.abort();
    },
    [],
  );

  const working =
    phase === "generating" || phase === "validating" || phase === "saving";

  const revise = useCallback(() => {
    const request = instruction.trim();
    if (!request || working) return;
    const run = ++runRef.current;
    const local = getStorageMode() === "local";
    const expectedWorld = structuredClone(world);
    setPhase("generating");
    setError(null);
    setErrorCode(undefined);
    setParts([]);
    setWarnings([]);
    const fail = (message: string, code?: GenerateWorldError["code"]) => {
      if (run !== runRef.current) return;
      abortRef.current = null;
      setPhase("error");
      setError(message);
      setErrorCode(code);
    };
    abortRef.current = api.reviseWorld(
      world.id,
      request,
      (event) => {
        if (run !== runRef.current) return;
        if (event.type === "progress") {
          setPhase(event.phase);
          if (event.parts) setParts(event.parts);
        } else if (event.type === "error") fail(event.message, event.code);
        else
          void (async () => {
            try {
              // A world that lives in this browser is kept here.
              const revised = local
                ? await getDataService().saveGeneratedWorld(event.world, {
                    expectedWorld,
                  })
                : event.world;
              if (run !== runRef.current) return;
              abortRef.current = null;
              setPhase("done");
              setInstruction("");
              setWarnings(event.warnings ?? []);
              onRevised(revised);
            } catch (err) {
              fail(err instanceof Error ? err.message : String(err));
            }
          })();
      },
      (err) => fail(err.message),
      local ? { world: expectedWorld } : undefined,
    );
  }, [instruction, onRevised, working, world]);

  return (
    <section
      aria-label={t("world.reviseTitle", "Revise this world")}
      className="space-y-3 rounded-(--radius-card) border border-border bg-card p-4"
    >
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Wand2 className="h-4 w-4 text-primary" />
          {t("world.reviseTitle", "Revise this world")}
        </h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t(
            "world.reviseHint",
            "Say what to change in your own words. Only that part is rewritten; sessions you already started keep the world they began with.",
          )}
        </p>
      </div>
      {worldEditionLocales(world).length > 1 && (
        <p className="text-xs leading-relaxed text-amber-600 dark:text-amber-400">
          {t(
            "world.reviseDropsEditions",
            "This world has editions in other languages. A revision removes them, because their text would no longer match. Translate the world again afterwards.",
          )}
        </p>
      )}
      <textarea
        value={instruction}
        maxLength={MAX_LENGTH}
        disabled={working}
        rows={3}
        onChange={(event) => setInstruction(event.target.value)}
        placeholder={t(
          "world.revisePlaceholder",
          "For example: make it three factions, or add a rival who wants the same thing.",
        )}
        aria-label={t("world.reviseRequest", "What to change")}
        className="w-full resize-y rounded-(--radius-control) border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-60"
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={working || !instruction.trim()}
          onClick={revise}
        >
          {working
            ? t("world.revising", "Revising…")
            : t("world.reviseAction", "Apply the change")}
        </Button>
      </div>
      <WorldGenerationStatus
        phase={phase}
        error={error}
        errorCode={errorCode}
        parts={parts}
        t={t}
        doneLabel={t("world.reviseDone", "The change is applied.")}
      />
      {warnings.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
