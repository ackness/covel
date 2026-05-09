import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { Media } from "@/components/Media.js";
import {
  usePluginJobs,
  usePluginNamespace,
} from "@/stores/plugin-data-store.js";
import { useSession } from "@/stores/session-store.js";
import { emitToast } from "@/lib/toast-channel.js";
import {
  compactJobId,
  formatJobDuration,
  jobStatusBadgeVariant,
} from "@/lib/job-ui.js";
import { findImageGeneratorRuntimeId, rerunImagePrompt } from "./actions.js";
import { ImagePreviewDialog } from "./image-preview-dialog.js";
import {
  findImagesByPrompt,
  getImageRef,
  getJobPromptContext,
  parseImageRows,
  type ImageRecord,
} from "./image-records.js";

export function ImageJobsPanel({ pluginId }: { pluginId: string }) {
  const { t } = useTranslation();
  const { state } = useSession();
  const sessionId = state.session?.id;
  const jobs = usePluginJobs(pluginId);
  const imageData = usePluginNamespace(pluginId, "images");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<ImageRecord | null>(null);
  const generatorRuntimeId = useMemo(
    () =>
      findImageGeneratorRuntimeId(
        state.sessionPlugins.find((p) => p.id === pluginId),
      ),
    [pluginId, state.sessionPlugins],
  );
  const images = useMemo(() => parseImageRows(imageData), [imageData]);

  if (jobs.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic text-center leading-relaxed px-4 pt-6">
        {t("coreImage.panel.noJobs")}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        {t("coreImage.panel.jobsHint")}
      </p>
      {jobs.map((job) => {
        const expanded = open[job.jobId] ?? job.status === "pending";
        const { prompt, promptMode, composition } = getJobPromptContext(job);
        const linkedImages = findImagesByPrompt(images, prompt);
        return (
          <div
            key={job.jobId}
            className="rounded-lg border border-border bg-card/60"
          >
            <button
              type="button"
              className="w-full flex items-center justify-between gap-2 p-2 text-left hover:bg-muted/40"
              onClick={() =>
                setOpen((prev) => ({ ...prev, [job.jobId]: !expanded }))
              }
            >
              <div className="flex items-center gap-1.5 min-w-0">
                {job.status === "pending" ? (
                  <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                ) : null}
                <Badge
                  variant={jobStatusBadgeVariant(job.status)}
                  className="text-[9px] h-4 px-1.5"
                >
                  {job.status}
                </Badge>
                <span className="font-mono text-[10px] truncate">
                  {compactJobId(job.jobId)}
                </span>
              </div>
              <span className="text-[10px] text-muted-foreground shrink-0">
                {formatJobDuration(job.durationMs)}
              </span>
            </button>
            {expanded && (
              <div className="px-2 pb-2 space-y-2 border-t border-border/60 pt-2">
                {job.runtimeId && (
                  <p className="font-mono text-[10px] text-muted-foreground">
                    {job.runtimeId}
                  </p>
                )}
                {prompt && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-medium text-muted-foreground">
                        {t("coreImage.panel.promptHeader")}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[10px]"
                        onClick={() => {
                          void navigator.clipboard?.writeText(prompt);
                          emitToast("info", t("coreImage.panel.promptCopied"));
                        }}
                      >
                        <Copy className="w-3 h-3 mr-1" />{" "}
                        {t("coreImage.panel.copy")}
                      </Button>
                    </div>
                    <p className="text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap max-h-48 overflow-auto rounded bg-muted/30 p-2">
                      {prompt}
                    </p>
                  </div>
                )}
                {linkedImages.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-medium text-muted-foreground">
                        {t("coreImage.panel.linkedImages", {
                          count: linkedImages.length,
                        })}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {linkedImages.map(({ key, value }) => {
                        const ref = getImageRef(value);
                        return (
                          <button
                            key={key}
                            type="button"
                            className="group relative overflow-hidden rounded-md border border-border bg-muted text-left"
                            onClick={() => ref && setPreview(value)}
                            disabled={!ref}
                            title={t("coreImage.panel.viewLarge")}
                          >
                            {ref ? (
                              <Media
                                src={ref}
                                sessionId={sessionId ?? ""}
                                alt={value.imageId ?? key}
                                aspectRatio="1/1"
                                rounded="none"
                                fit="cover"
                              />
                            ) : (
                              <div className="aspect-square flex items-center justify-center text-[10px] text-muted-foreground">
                                no image
                              </div>
                            )}
                            <span className="absolute left-1 bottom-1 rounded bg-background/85 px-1 py-0.5 font-mono text-[9px] text-muted-foreground">
                              {compactJobId(value.imageId ?? key)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {job.error && (
                  <p className="text-[11px] leading-relaxed text-destructive whitespace-pre-wrap">
                    {job.error}
                  </p>
                )}
                {prompt && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[10px] w-full"
                    onClick={() => {
                      rerunImagePrompt({
                        sessionId,
                        pluginId,
                        runtimeId: generatorRuntimeId,
                        payload: { prompt, promptMode, composition },
                      });
                    }}
                  >
                    {t("coreImage.panel.rerunWithPrompt")}
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}
      <ImagePreviewDialog
        preview={preview}
        sessionId={sessionId}
        onClose={() => setPreview(null)}
      />
    </div>
  );
}
