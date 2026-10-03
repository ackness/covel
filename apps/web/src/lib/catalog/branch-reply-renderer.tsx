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
      {/* Each variant is an option: choosing it accepts that version of the
          reply. Drafting or sending its text stays a secondary action. */}
      <div role="group" className="ui-choice-list">
        {variants.map((candidate) => {
          const accepted = candidate.id === acceptedCandidateId;
          const details = (data?.detailFields ?? [])
            .map((field) => resolvePath(candidate.row, field))
            .filter(Boolean)
            .join(" · ");
          return (
            <div key={candidate.id} className="ui-choice-row">
              <button
                type="button"
                className="ui-choice"
                onClick={() =>
                  void invokeAction("accept", data?.acceptAction, candidate)
                }
                disabled={
                  !sessionId || !data?.acceptAction || pendingAction !== null
                }
                aria-pressed={accepted}
                aria-busy={pendingAction === "accept" || undefined}
                data-selected={accepted ? "true" : undefined}
              >
                <span aria-hidden="true" className="ui-choice-index" />
                <span className="ui-choice-content">
                  <span className="ui-choice-title whitespace-pre-wrap">
                    {candidate.content}
                  </span>
                </span>
                <span className="ui-choice-eyebrow inline-flex items-center gap-1">
                  {pendingAction === "accept" ? (
                    <Loader2
                      aria-hidden="true"
                      className="h-3 w-3 animate-spin"
                    />
                  ) : (
                    accepted && <Check aria-hidden="true" className="h-3 w-3" />
                  )}
                  {acceptLabel}
                </span>
              </button>
              <div className="ui-choice-actions flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => draftCandidate(candidate)}
                  className="ui-btn ui-btn-quiet h-7 px-2 text-[11px] text-muted-foreground"
                >
                  {draftLabel}
                </button>
                <button
                  type="button"
                  onClick={() => sendCandidate(candidate)}
                  className="ui-btn ui-btn-quiet h-7 px-2 text-[11px] text-muted-foreground"
                >
                  {sendLabel}
                </button>
                {details && (
                  <span className="font-mono text-[9px] text-muted-foreground/60">
                    {details}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
