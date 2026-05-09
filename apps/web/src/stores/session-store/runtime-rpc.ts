import i18n from "i18next";
import * as api from "@/services/api";
import type { DataService } from "@/services/data-service.js";
import { emitToast } from "@/lib/toast-channel.js";
import type { SseEventHandler } from "./sse-handler.js";
import type { SessionDispatch } from "./types.js";

export const CONNECTION_CLOSED_REASON =
  "__i18n:session.reasonConnectionClosed__";

export function finalizeActionExecution(dispatch: SessionDispatch): void {
  dispatch({ type: "SET_EXECUTING", value: false });
  dispatch({
    type: "FINALIZE_HANGING_RUNTIMES",
    reason: CONNECTION_CLOSED_REASON,
  });
}

export function runActionStream(
  request: api.ActionRequest,
  handleSseEvent: SseEventHandler,
  dispatch: SessionDispatch,
  opts?: { toastOnError?: boolean },
): Promise<void> {
  return new Promise<void>((resolve) => {
    api.sendAction(
      request,
      handleSseEvent,
      (err) => {
        dispatch({ type: "SET_EXECUTION_ERROR", error: err.message });
        if (opts?.toastOnError) {
          emitToast(
            "error",
            i18n.t("toast.sendMessageFailed", {
              defaultValue: "Failed to send message",
            }) as string,
            err.message,
          );
        }
        resolve();
      },
      () => {
        resolve();
      },
    );
  });
}

export function ensureServerThenRun(
  ds: DataService,
  sessionId: string,
  fireAction: () => void,
): void {
  api
    .ensureServerSession(sessionId, (sid) => ds.syncToServer(sid))
    .then(fireAction)
    .catch(fireAction);
}
