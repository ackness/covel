import { MediaGalleryPanel } from "./image-gallery-panel.js";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Loader2 } from "lucide-react";
import { jobListPropsSchema } from "@covel/shared";
import { Button } from "@/components/ui/button.js";
import {
  catalogItems,
  invokeCatalogAction,
} from "@/lib/catalog/catalog-actions.js";
import { resolvePath, useI18nResolver } from "@/lib/catalog/helpers.js";
import { useActiveSessionId } from "@/lib/catalog/session-context.js";
import { emitToast } from "@/lib/toast-channel.js";
import { compactJobId, formatJobDuration } from "@/lib/job-ui.js";

export function JobListPanel({
  props: input,
}: {
  props: Record<string, unknown>;
}) {
  const { t } = useTranslation();
  const resolve = useI18nResolver();
  const sessionId = useActiveSessionId();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const parsed = jobListPropsSchema.safeParse(input);
  if (!parsed.success) return null;
  const props = parsed.data;
  const items = catalogItems(props.items);
  if (!items.length)
    return (
      <p className="text-xs text-muted-foreground italic text-center px-4 pt-6">
        {resolve(input.emptyText) || t("coreImage.panel.noJobs")}
      </p>
    );
  return (
    <div className="space-y-2">
      {items.map((item, index) => {
        const id = String(resolvePath(item, props.idField) ?? index);
        const status = String(resolvePath(item, props.statusField) ?? "");
        const pending = ["pending", "queued", "running"].includes(status);
        const expanded = open[id] ?? pending;
        const duration = resolvePath(item, props.durationField);
        const message = resolvePath(item, props.messageField);
        const error = resolvePath(item, props.errorField);
        const related = props.relatedMedia;
        const match = related
          ? resolvePath(item, related.itemField)
          : undefined;
        const relatedItems =
          related && match != null && match !== ""
            ? catalogItems(related.items).filter(
                (record) => resolvePath(record, related.matchField) === match,
              )
            : [];

        return (
          <div
            key={id}
            className="image-job-row rounded-lg border border-border bg-card/60"
          >
            <button
              type="button"
              className="w-full flex items-center justify-between gap-2 p-2 text-left hover:bg-muted/40"
              onClick={() =>
                setOpen((current) => ({ ...current, [id]: !expanded }))
              }
            >
              <div className="flex items-center gap-1.5 text-[10px]">
                {pending ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                <span>{status}</span>
                <span className="font-mono">{compactJobId(id)}</span>
              </div>
              {typeof duration === "number" ? (
                <span className="text-[10px]">
                  {formatJobDuration(duration)}
                </span>
              ) : null}
            </button>
            {expanded ? (
              <div className="px-2 pb-2 space-y-2 border-t border-border/60 pt-2">
                {props.fields?.map((field) => {
                  const value = resolvePath(item, field.path);
                  if (value == null) return null;
                  const text =
                    typeof value === "string" ? value : JSON.stringify(value);
                  return (
                    <div key={field.path} className="space-y-1.5">
                      <div className="flex justify-between text-[10px]">
                        <span>{resolve(field.label)}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            void navigator.clipboard?.writeText(text);
                          }}
                        >
                          <Copy className="w-3 h-3" />
                          {t("coreImage.panel.copy")}
                        </Button>
                      </div>
                      <p className="text-[11px] whitespace-pre-wrap max-h-48 overflow-auto rounded bg-muted/30 p-2">
                        {text}
                      </p>
                    </div>
                  );
                })}
                {related && relatedItems.length ? (
                  <MediaGalleryPanel
                    props={{
                      items: relatedItems,
                      idField: related.idField,
                      refField: related.refField,
                      titleField: related.titleField,
                    }}
                  />
                ) : null}
                {message ? (
                  <p className="text-[11px] text-muted-foreground whitespace-pre-wrap">
                    {String(message)}
                  </p>
                ) : null}
                {error ? (
                  <p className="text-[11px] text-destructive whitespace-pre-wrap">
                    {String(error)}
                  </p>
                ) : null}
                {props.rerunAction ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !sessionId}
                    onClick={() => {
                      if (!sessionId || !props.rerunAction) return;
                      setBusy(true);
                      void invokeCatalogAction({
                        sessionId,
                        action: props.rerunAction,
                        scope: { item, props: input },
                        t,
                      })
                        .catch((err) => emitToast("error", String(err)))
                        .finally(() => setBusy(false));
                    }}
                  >
                    {resolve(props.rerunAction.label) ||
                      t("coreImage.panel.rerun")}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
