/**
 * Desktop only: tells the player when the local server behind the app has
 * stopped, instead of leaving a page whose requests silently fail.
 *
 * The desktop main process watches the server and reports its state (see
 * `subscribeServerStatus`). While it restarts the server on its own, this
 * shows a waiting screen; the main process then reloads this window on the
 * page it shows now. When the restarts are used up, the player restarts the
 * server from here. In a browser no status ever arrives and nothing renders.
 */

import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  reloadServerAndWait,
  subscribeServerStatus,
  type ServerStatus,
} from "@/lib/desktop-bridge.js";

export function ServerStatusOverlay() {
  const { t } = useTranslation();
  const titleId = useId();
  const hintId = useId();
  const [state, setState] = useState<ServerStatus["state"]>("up");
  const [restartRequested, setRestartRequested] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);

  useEffect(
    () =>
      subscribeServerStatus((status) => {
        setState(status.state);
        // A new report replaces what an earlier manual restart ended with.
        if (status.state !== "down") setRestartError(null);
      }),
    [],
  );

  // `degraded` means the server answers, with an error: the page still works.
  if (state === "up" || state === "degraded") return null;

  const restart = async () => {
    setRestartRequested(true);
    setRestartError(null);
    try {
      // Resolves once the server is ready; the main process then loads this
      // page from it, so the request stays "in progress" until the page goes.
      await reloadServerAndWait();
    } catch (error) {
      setRestartError(error instanceof Error ? error.message : String(error));
      setRestartRequested(false);
    }
  };

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={hintId}
      data-server-state={state}
      className="fixed inset-0 z-150 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm"
    >
      {state === "restarting" ? (
        <div className="flex flex-col items-center gap-3 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <div id={titleId} className="text-sm font-medium">
            {t(
              "serverStatus.restarting",
              "The local server stopped. Restarting…",
            )}
          </div>
          <div id={hintId} className="text-xs text-muted-foreground">
            {t(
              "serverStatus.restartingHint",
              "This page reloads when the server is back.",
            )}
          </div>
        </div>
      ) : (
        <div className="w-full max-w-md space-y-4 rounded-(--radius-control) border border-border bg-background p-6">
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle className="h-5 w-5 shrink-0" />
            <span id={titleId} className="text-sm font-medium">
              {t("serverStatus.down", "Disconnected from the local server")}
            </span>
          </div>
          <p id={hintId} className="text-sm text-muted-foreground">
            {t(
              "serverStatus.downHint",
              "Covel cannot reach its local server. Completed turns are saved. Restart the server to continue.",
            )}
          </p>
          {restartError && (
            <div role="alert" className="space-y-1">
              <p className="text-sm text-destructive">
                {t(
                  "serverStatus.restartFailed",
                  "The server did not start. Try again, or quit and reopen Covel.",
                )}
              </p>
              <p className="text-xs break-all text-muted-foreground">
                {restartError}
              </p>
            </div>
          )}
          <Button
            type="button"
            autoFocus
            disabled={restartRequested}
            onClick={() => void restart()}
          >
            {restartRequested && <Loader2 className="animate-spin" />}
            {t("serverStatus.restart", "Restart server")}
          </Button>
        </div>
      )}
    </div>
  );
}
