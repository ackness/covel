import { useState } from "react";
import type { ComponentRenderer } from "@json-render/react";
import { clsx } from "clsx";
import * as Icons from "lucide-react";
import { postPluginRpc } from "@/services/api.js";
import { emitToast } from "@/lib/toast-channel.js";
import { useSession } from "@/stores/session-store.js";
import { asRecord, useI18nResolver } from "./helpers.js";

interface BranchReplyCandidate {
  readonly id: string;
  readonly runtimeId?: string;
  readonly content: string;
  readonly createdAt?: string;
  readonly source?: string;
  readonly traceId?: string;
}

function normalizeBranchReplyCandidates(value: unknown): {
  turnId?: string;
  acceptedCandidateId?: string;
  candidates: BranchReplyCandidate[];
} {
  let data = asRecord(value);
  if (!data) return { candidates: [] };

  if (!Array.isArray(data.candidates)) {
    for (const key of ["candidateSet", "replySet", "value", "data"]) {
      const nested = asRecord(data[key]);
      if (nested && Array.isArray(nested.candidates)) {
        data = nested;
        break;
      }
    }
  }

  const turnId = typeof data.turnId === "string" ? data.turnId : undefined;
  const acceptedCandidateId =
    typeof data.acceptedCandidateId === "string"
      ? data.acceptedCandidateId
      : undefined;
  const rawCandidates = Array.isArray(data.candidates) ? data.candidates : [];
  const candidates = rawCandidates.flatMap((raw): BranchReplyCandidate[] => {
    const candidate = asRecord(raw);
    if (!candidate) return [];
    const id = String(candidate.id ?? "").trim();
    const content = String(candidate.content ?? candidate.text ?? "").trim();
    if (!id || !content) return [];
    return [
      {
        id,
        content,
        runtimeId:
          typeof candidate.runtimeId === "string"
            ? candidate.runtimeId
            : undefined,
        createdAt:
          typeof candidate.createdAt === "string"
            ? candidate.createdAt
            : undefined,
        source:
          typeof candidate.source === "string" ? candidate.source : undefined,
        traceId:
          typeof candidate.traceId === "string" ? candidate.traceId : undefined,
      },
    ];
  });

  return { turnId, acceptedCandidateId, candidates };
}

/**
 * BranchReplyCandidates — lightweight candidate-reply switcher for
 * branch-reply plugin data. Draft/send use the existing session draft path;
 * accept/regenerate call plugin-rpc directly for block-rendered candidate UI.
 */
export const BranchReplyCandidates: ComponentRenderer = ({ element }) => {
  const resolve = useI18nResolver();
  const { state, sendMessage, upsertInteractionDraft } = useSession();
  const sessionId = state.session?.id;
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const props = element.props ?? {};
  const payload =
    props.value ?? props.candidateSet ?? props.replySet ?? props.data ?? props;
  const { turnId, acceptedCandidateId, candidates } =
    normalizeBranchReplyCandidates(payload);
  const pluginId =
    typeof props.pluginId === "string" ? props.pluginId : "branch-reply";
  const title = resolve(props.title) || "Reply candidates";
  const draftLabel = resolve(props.draftLabel) || "Draft";
  const sendLabel = resolve(props.sendLabel) || "Send";
  const acceptLabel = resolve(props.acceptLabel) || "Accept";
  const regenerateLabel = resolve(props.regenerateLabel) || "Regenerate";

  if (candidates.length === 0) return null;

  const selectionGroup = turnId
    ? `branch-reply:${turnId}`
    : `branch-reply:${candidates[0]?.id ?? "candidate"}`;
  const canInvokeRuntime = Boolean(sessionId && turnId);

  const draftCandidate = (candidate: BranchReplyCandidate) => {
    upsertInteractionDraft({
      id: `${selectionGroup}:${candidate.id}`,
      turnId: turnId ?? "branch-reply",
      interactionId: selectionGroup,
      type: "suggestion",
      label: candidate.content,
      values: { text: candidate.content, candidateId: candidate.id },
      selectionGroup,
    });
  };

  const sendCandidate = (candidate: BranchReplyCandidate) => {
    const text = candidate.content.trim();
    if (text) sendMessage(text);
  };

  const invokeBranchReplyAction = async (
    action: "acceptCandidate" | "createCandidates",
    payload: Record<string, unknown>,
  ) => {
    if (!sessionId || !turnId || pendingAction) return;
    setPendingAction(action);
    try {
      const res = await postPluginRpc(sessionId, {
        pluginId,
        runtimeId: "branch-reply",
        payload,
      });
      if (res.status === "error") {
        emitToast("error", res.error);
      } else if (res.status === "accepted") {
        emitToast("info", `Submitted branch-reply job: ${res.jobId}`);
      } else if (res.status === "approval-required") {
        emitToast("error", "Branch reply action requires approval.");
      } else if (res.status === "ok") {
        const runtimeError = res.runtimeResults?.find(
          (r) =>
            r.status === "failed" ||
            (typeof r.error === "string" && r.error.length > 0),
        )?.error;
        if (runtimeError || res.abortReason) {
          emitToast(
            "error",
            runtimeError ?? res.abortReason ?? "Branch reply action failed",
          );
        }
      }
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
        {turnId && (
          <button
            type="button"
            onClick={() =>
              void invokeBranchReplyAction("createCandidates", {
                action: "createCandidates",
                turnId,
                baseText: candidates[0]?.content,
                count: candidates.length,
              })
            }
            disabled={!canInvokeRuntime || pendingAction !== null}
            aria-busy={pendingAction === "createCandidates" || undefined}
            className="inline-flex items-center gap-1 rounded-[var(--radius-control)] border border-border px-2 py-1 text-[11px] text-muted-foreground hover:border-foreground/40 hover:text-foreground transition-colors"
          >
            <Icons.RefreshCw
              className={clsx(
                "w-3 h-3",
                pendingAction === "createCandidates" && "animate-spin",
              )}
            />
            <span>{regenerateLabel}</span>
          </button>
        )}
      </div>
      <div className="space-y-1.5">
        {candidates.map((candidate, index) => {
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
                  <Icons.Check className="w-3.5 h-3.5 shrink-0 text-primary mt-0.5" />
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5 pl-5">
                <button
                  type="button"
                  onClick={() => draftCandidate(candidate)}
                  className="font-medium rounded-[var(--radius-control)] transition-all text-left inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] bg-transparent text-muted-foreground border border-dashed border-border hover:border-foreground/40 hover:text-foreground"
                >
                  {draftLabel}
                </button>
                <button
                  type="button"
                  onClick={() => sendCandidate(candidate)}
                  className="font-medium rounded-[var(--radius-control)] transition-all text-left inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] bg-transparent text-foreground border border-border hover:border-foreground/40 hover:bg-foreground/5"
                >
                  {sendLabel}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void invokeBranchReplyAction("acceptCandidate", {
                      action: "acceptCandidate",
                      turnId,
                      candidateId: candidate.id,
                    })
                  }
                  disabled={!canInvokeRuntime || pendingAction !== null}
                  aria-busy={pendingAction === "acceptCandidate" || undefined}
                  className={clsx(
                    "font-medium rounded-[var(--radius-control)] transition-all text-left inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] border",
                    accepted
                      ? "bg-foreground text-[var(--surface-page)] border-foreground hover:bg-foreground/90"
                      : "bg-transparent text-muted-foreground border-dashed border-border hover:border-foreground/40 hover:text-foreground",
                    pendingAction !== null && "opacity-70 cursor-progress",
                  )}
                >
                  {pendingAction === "acceptCandidate" && (
                    <Icons.Loader2
                      aria-hidden="true"
                      className="w-3 h-3 animate-spin"
                    />
                  )}
                  {acceptLabel}
                </button>
                {(candidate.source || candidate.runtimeId) && (
                  <span className="font-mono text-[9px] text-muted-foreground/60">
                    {[candidate.source, candidate.runtimeId]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <span className="sr-only">{pluginId}</span>
    </div>
  );
};
