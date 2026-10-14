import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExecutionRecovery,
  StreamMessage,
} from "@/stores/session-store/types.js";

/** A local reading copy, separate from saved story and stage content. */
export function UnsavedNarratives({
  messages,
  recovery,
  executing,
  onRetry,
}: {
  messages: readonly StreamMessage[];
  recovery?: ExecutionRecovery | null;
  executing: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const [retriedTurnId, setRetriedTurnId] = useState<string>();
  if (!messages.length) return null;
  const status = recovery?.status;
  const canRetry =
    !executing &&
    !recovery?.checking &&
    !recovery?.hydrating &&
    !recovery?.error &&
    !!status?.retry &&
    (status.state === "failed" || status.state === "interrupted");
  return (
    <div className="max-h-60 shrink-0 overflow-y-auto border-b border-border bg-background/95 px-4 py-3">
      {messages.map((message) => (
        <section key={message.id} className="mx-auto max-w-3xl py-2">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-amber-600">
              {t("session.unsavedNarrative")}
            </span>
            {canRetry && message.turnId === status?.turnId && (
              <button
                type="button"
                disabled={retriedTurnId === message.turnId}
                className="rounded-(--radius-control) bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
                onClick={() => {
                  setRetriedTurnId(message.turnId);
                  onRetry();
                }}
              >
                {t("session.recoveryRetry")}
              </button>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("session.unsavedNarrativeDetail")}
          </p>
          <p className="mt-2 whitespace-pre-wrap text-sm">{message.content}</p>
        </section>
      ))}
    </div>
  );
}
