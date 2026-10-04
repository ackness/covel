import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Languages } from "lucide-react";
import { localesShareLanguageAndScript } from "@covel/shared";
import { Button } from "@/components/ui/button.js";
import * as api from "@/services/api.js";
import type { TranslateWorldEvent, WorldRecord } from "@/services/api.js";
import { worldLanguageName, worldPlayLocale } from "@/lib/world-locale.js";

/**
 * Whether the world can get an edition in `interfaceLocale` here: it has
 * none yet, and it is a package of files on the server. The server makes the
 * last check: it writes only into the user's world directory.
 */
export function isWorldTranslatable(
  world: WorldRecord,
  interfaceLocale: string | undefined,
): boolean {
  if (!interfaceLocale || !world.locale) return false;
  const storage = world.metadata?.storage as
    { scope?: string; backend?: string } | undefined;
  if (storage?.scope !== "server" || storage.backend !== "file") return false;
  const play = worldPlayLocale(world, interfaceLocale);
  return !localesShareLanguageAndScript(play, interfaceLocale);
}

type Phase = "idle" | "confirm" | "working" | "error";

interface WorldTranslatePanelProps {
  world: WorldRecord;
  /** The language to translate into: the player's interface language. */
  locale: string;
  onTranslated: (world: WorldRecord) => void;
}

/**
 * Offer a world in the player's language. The model translates every text of
 * the world, so the player confirms first: it costs model calls.
 */
export function WorldTranslatePanel({
  world,
  locale,
  onTranslated,
}: WorldTranslatePanelProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);

  useEffect(
    () => () => {
      runRef.current += 1;
      abortRef.current?.abort();
    },
    [],
  );

  const language = worldLanguageName(locale, locale) ?? locale;
  const worldLanguage = worldLanguageName(world.locale, locale) ?? world.locale;

  const start = useCallback(() => {
    const run = ++runRef.current;
    setPhase("working");
    setError(null);
    setProgress(null);
    const fail = (message: string) => {
      if (run !== runRef.current) return;
      abortRef.current = null;
      setPhase("error");
      setError(message);
    };
    abortRef.current = api.translateWorld(
      world.id,
      locale,
      (event: TranslateWorldEvent) => {
        if (run !== runRef.current) return;
        if (event.type === "progress")
          setProgress(`${event.done} / ${event.total}`);
        else if (event.type === "error") fail(event.message);
        else {
          abortRef.current = null;
          setPhase("idle");
          onTranslated(event.world);
        }
      },
      (err) => fail(err.message),
    );
  }, [locale, onTranslated, world.id]);

  const cancel = useCallback(() => {
    runRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase("idle");
  }, []);

  return (
    <section
      aria-label={t("world.translateTitle", "Translate this world")}
      className="space-y-3 rounded-(--radius-card) border border-border bg-card p-4"
    >
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Languages className="h-4 w-4 text-primary" />
          {t("world.translateTitle", "Translate this world")}
        </h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t(
            "world.translateHint",
            "This world is written in {{worldLanguage}}, and a session plays in a language the world has. You can add a {{language}} edition.",
            { worldLanguage, language },
          )}
        </p>
      </div>
      {phase === "confirm" && (
        <p className="text-xs leading-relaxed text-foreground">
          {t(
            "world.translateConfirm",
            "Your model translates every text of the world: names, lore, rules and characters. This uses model calls, and a machine translation of names and tone needs a look afterwards.",
          )}
        </p>
      )}
      {phase === "working" && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("world.translating", "Translating…")}
          {progress ? ` ${progress}` : ""}
        </p>
      )}
      {phase === "error" && error && (
        <div className="flex items-start gap-2 rounded-(--radius-control) border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="wrap-break-word">{error}</span>
        </div>
      )}
      <div className="flex justify-end gap-2">
        {(phase === "confirm" || phase === "working") && (
          <Button size="sm" variant="ghost" onClick={cancel}>
            {t("common.cancel", "Cancel")}
          </Button>
        )}
        {phase === "confirm" ? (
          <Button size="sm" onClick={start}>
            {t("world.translateStart", "Start the translation")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={phase === "working"}
            onClick={() => setPhase("confirm")}
          >
            {t("world.translateAction", "Translate to {{language}}", {
              language,
            })}
          </Button>
        )}
      </div>
    </section>
  );
}
