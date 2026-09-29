import { useState } from "react";
import { candidateListPropsSchema, type CatalogAction } from "@covel/shared";
import { invokeCatalogAction } from "./catalog-actions.js";
import { useTranslation } from "react-i18next";
import type { ComponentRenderer } from "@json-render/react";
import { clsx } from "clsx";
import { Check, Loader2, RefreshCw } from "lucide-react";
import { emitToast } from "@/lib/toast-channel.js";
import { useSession } from "@/stores/session-store.js";
import { resolvePath, useI18nResolver } from "./helpers.js";

interface Candidate {
  id: string;
  content: string;
  source?: string;
  runtimeId?: string;
  row: Record<string, unknown>;
}

/** Candidate presentation and generic RPC actions supplied by the owning spec. */
export const CandidateList: ComponentRenderer = ({ element }) => {
  const { t } = useTranslation();
  const resolve = useI18nResolver();
  const { state, sendMessage, upsertInteractionDraft } = useSession();
  const sessionId = state.session?.id;
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const props = element.props ?? {};
  const parsed = candidateListPropsSchema.safeParse(props);
  const data = parsed.success ? parsed.data : undefined;
  const turnId = data?.turnId;
  const acceptedCandidateId = data?.acceptedId;
  const candidates: Candidate[] = (data?.candidates ?? []).flatMap((row) => {
    const id = String(resolvePath(row, data!.idField) ?? "");
    const content = String(resolvePath(row, data!.contentField) ?? "");
    return id && content ? [{ id, content, row }] : [];
  });
  const title =
    resolve(props.title) ||
    t("branchReply.replyCandidates", "Reply candidates");
  const draftLabel =
    resolve(props.draftLabel) || t("branchReply.draft", "Draft");
  const sendLabel = resolve(props.sendLabel) || t("branchReply.send", "Send");
  const acceptLabel =
    resolve(props.acceptLabel) || t("branchReply.accept", "Accept");
  const regenerateLabel =
    resolve(props.regenerateLabel) || t("branchReply.regenerate", "Regenerate");

  if (candidates.length === 0) return null;

  const variants = candidates.filter(
    (c) =>
      !data?.hiddenWhen ||
      resolvePath(c.row, data.hiddenWhen.field) !== data.hiddenWhen.equals,
  );
  const selectionGroup = `candidates:${turnId ?? candidates[0]?.id ?? "list"}`;
  const draftCandidate = (candidate: Candidate) => {
    upsertInteractionDraft({
      id: `${selectionGroup}:${candidate.id}`,
      turnId: turnId ?? "candidates",
      interactionId: selectionGroup,
      type: "suggestion",
      label: candidate.content,
      values: { text: candidate.content, candidateId: candidate.id },
      selectionGroup,
    });
  };

  const sendCandidate = (candidate: Candidate) => {
    const text = candidate.content.trim();
    if (text) sendMessage(text);
  };

  const invokeAction = async (
    name: string,
    action: CatalogAction | undefined,
    candidate?: Candidate,
  ) => {
    if (!sessionId || !action || pendingAction) return;
    setPendingAction(name);
    try {
      await invokeCatalogAction({
        sessionId,
        action,
        scope: { props, item: candidate?.row },
        t,
      });
    } catch (err) {
      emitToast("error", err instanceof Error ? err.message : String(err));
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div className="ui-band space-y-2.5" data-tone="muted">
      <div className="flex items-center justify-between gap-3">
        <span className="ui-eyebrow text-[11px] text-muted-foreground">
          {title}
        </span>
        {data?.regenerateAction && (
          <button
            type="button"
            onClick={() =>
              void invokeAction("regenerate", data?.regenerateAction)
            }
            disabled={!sessionId || pendingAction !== null}
            aria-busy={pendingAction === "regenerate" || undefined}
            className="inline-flex items-center gap-1 rounded-(--radius-control) border border-border px-2 py-1 text-[11px] text-muted-foreground hover:border-foreground/40 hover:text-foreground transition-colors"
          >
            <RefreshCw
              className={clsx(
                "w-3 h-3",
                pendingAction === "regenerate" && "animate-spin",
              )}
            />
            <span>{regenerateLabel}</span>
          </button>
        )}
      </div>
      {variants.length === 0 && (
        <p className="text-[11px] italic text-muted-foreground">
          {t(
            "branchReply.regenerateHint",
            "Tap Regenerate for alternative phrasings of this reply.",
          )}
        </p>
      )}
      <div className="space-y-1.5">
        {variants.map((candidate, index) => {
          const accepted = candidate.id === acceptedCandidateId;
          return (
            <div
              key={candidate.id}
              className={clsx(
                "border border-border bg-background/70 px-3 py-2.5 space-y-2",
                accepted && "border-primary/50 bg-primary/5",
              )}
            >
              <div className="flex items-start gap-2">
                <span className="font-mono text-[10px] text-muted-foreground/70 pt-0.5">
                  {index + 1}
                </span>
                <p className="flex-1 whitespace-pre-wrap text-[13px] leading-[1.55] text-foreground">
                  {candidate.content}
                </p>
                {accepted && (
                  <Check className="w-3.5 h-3.5 shrink-0 text-primary mt-0.5" />
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5 pl-5">
                <button
                  type="button"
                  onClick={() => draftCandidate(candidate)}
                  className="font-medium rounded-(--radius-control) transition-all text-left inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] bg-transparent text-muted-foreground border border-dashed border-border hover:border-foreground/40 hover:text-foreground"
                >
                  {draftLabel}
                </button>
                <button
                  type="button"
                  onClick={() => sendCandidate(candidate)}
                  className="font-medium rounded-(--radius-control) transition-all text-left inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] bg-transparent text-foreground border border-border hover:border-foreground/40 hover:bg-foreground/5"
                >
                  {sendLabel}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void invokeAction("accept", data?.acceptAction, candidate)
                  }
                  disabled={
                    !sessionId || !data?.acceptAction || pendingAction !== null
                  }
                  aria-busy={pendingAction === "accept" || undefined}
                  className={clsx(
                    "font-medium rounded-(--radius-control) transition-all text-left inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] border",
                    accepted
                      ? "bg-foreground text-(--surface-page) border-foreground hover:bg-foreground/90"
                      : "bg-transparent text-muted-foreground border-dashed border-border hover:border-foreground/40 hover:text-foreground",
                    pendingAction !== null && "opacity-70 cursor-progress",
                  )}
                >
                  {pendingAction === "accept" && (
                    <Loader2
                      aria-hidden="true"
                      className="w-3 h-3 animate-spin"
                    />
                  )}
                  {acceptLabel}
                </button>
                {data?.detailFields?.length ? (
                  <span className="font-mono text-[9px] text-muted-foreground/60">
                    {data.detailFields
                      .map((field) => resolvePath(candidate.row, field))
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
