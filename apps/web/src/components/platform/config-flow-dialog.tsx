import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ConfigFlowField,
  ConfigFlowRunSnapshot,
  ConfigFlowStep,
} from "@covel/shared/platform";
import { Copy, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import { openExternalUrl } from "@/lib/desktop-bridge.js";
import {
  bumpPlatformInstanceDataVersion,
  closePluginConfigFlow,
  usePlatformUiState,
} from "@/lib/platform-ui-events.js";
import { emitToast } from "@/lib/toast-channel.js";
import {
  cancelPluginConfigFlow,
  getPluginConfigFlowRun,
  startPluginConfigFlow,
  stepPluginConfigFlow,
} from "@/services/api.js";

function initFormValues(
  fields: readonly ConfigFlowField[],
): Record<string, unknown> {
  const initial: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.defaultValue !== undefined) {
      initial[field.name] = field.defaultValue;
    } else if (field.type === "boolean") {
      initial[field.name] = false;
    } else if (field.type === "select") {
      initial[field.name] = field.options?.[0]?.value ?? "";
    } else {
      initial[field.name] = "";
    }
  }
  return initial;
}

type StepSubmitHandler = (payload: {
  readonly stepId: string;
  readonly data?: Record<string, unknown>;
  readonly callbackUrl?: string;
  readonly cancelled?: boolean;
}) => Promise<void>;

function CancelFooter({
  onDismiss,
  cancelLabel,
  children,
}: {
  readonly onDismiss: () => void;
  readonly cancelLabel: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex justify-end gap-2 pt-2">
      <Button type="button" variant="outline" onClick={onDismiss}>
        {cancelLabel}
      </Button>
      {children}
    </div>
  );
}

function FormStepView({
  step,
  locale,
  submitting,
  formValues,
  setFormValues,
  setErrorMessage,
  onSubmitStep,
  onDismiss,
}: {
  readonly step: Extract<ConfigFlowStep, { kind: "form" }>;
  readonly locale: string | undefined;
  readonly submitting: boolean;
  readonly formValues: Record<string, unknown>;
  readonly setFormValues: React.Dispatch<
    React.SetStateAction<Record<string, unknown>>
  >;
  readonly setErrorMessage: (message: string | null) => void;
  readonly onSubmitStep: StepSubmitHandler;
  readonly onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        for (const field of step.fields) {
          if (!field.required) continue;
          const val = formValues[field.name];
          if (
            val === undefined ||
            val === null ||
            (typeof val === "string" && val.trim().length === 0)
          ) {
            setErrorMessage(
              t("platform.fieldRequired", {
                field: resolveDisplayText(field.label, locale) || field.name,
                defaultValue: "{{field}} is required",
              }),
            );
            return;
          }
        }
        const normalized: Record<string, unknown> = {};
        for (const field of step.fields) {
          const raw = formValues[field.name];
          if (field.type === "number" && raw !== "" && raw !== undefined) {
            const parsed = Number(raw);
            if (!Number.isFinite(parsed)) {
              setErrorMessage(
                t("platform.fieldInvalidNumber", {
                  field: resolveDisplayText(field.label, locale) || field.name,
                  defaultValue: "{{field}} must be a valid number",
                }),
              );
              return;
            }
            normalized[field.name] = parsed;
          } else {
            normalized[field.name] = raw;
          }
        }
        void onSubmitStep({ stepId: step.stepId, data: normalized });
      }}
    >
      {step.fields.map((field) => {
        const label = resolveDisplayText(field.label, locale) || field.name;
        const help =
          field.description !== undefined
            ? resolveDisplayText(field.description, locale)
            : "";
        const placeholder =
          field.placeholder !== undefined
            ? resolveDisplayText(field.placeholder, locale)
            : undefined;
        const inputId = `flow-field-${field.name}`;
        return (
          <div key={field.name} className="space-y-1.5">
            {field.type === "boolean" ? (
              <label
                htmlFor={inputId}
                className="flex items-center gap-2 text-sm font-medium"
              >
                <input
                  id={inputId}
                  type="checkbox"
                  checked={Boolean(formValues[field.name])}
                  onChange={(e) =>
                    setFormValues((prev) => ({
                      ...prev,
                      [field.name]: e.target.checked,
                    }))
                  }
                />
                <span>{label}</span>
              </label>
            ) : (
              <>
                <label htmlFor={inputId} className="block text-sm font-medium">
                  {label}
                  {field.required && (
                    <span className="ml-1 text-destructive">*</span>
                  )}
                </label>
                {field.type === "select" ? (
                  <select
                    id={inputId}
                    value={String(formValues[field.name] ?? "")}
                    onChange={(e) =>
                      setFormValues((prev) => ({
                        ...prev,
                        [field.name]: e.target.value,
                      }))
                    }
                    className="w-full rounded-(--radius-control) border border-input bg-background px-3 py-1.5 text-sm"
                  >
                    {(field.options ?? []).map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {resolveDisplayText(opt.label, locale) || opt.value}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={inputId}
                    type={
                      field.type === "secret"
                        ? "password"
                        : field.type === "url"
                          ? "url"
                          : field.type === "number"
                            ? "number"
                            : "text"
                    }
                    value={String(formValues[field.name] ?? "")}
                    placeholder={placeholder}
                    required={field.required}
                    onChange={(e) =>
                      setFormValues((prev) => ({
                        ...prev,
                        [field.name]: e.target.value,
                      }))
                    }
                    className="w-full rounded-(--radius-control) border border-input bg-background px-3 py-1.5 text-sm"
                  />
                )}
              </>
            )}
            {help && <p className="text-xs text-muted-foreground">{help}</p>}
          </div>
        );
      })}
      <CancelFooter
        onDismiss={onDismiss}
        cancelLabel={t("common.cancel", "Cancel")}
      >
        <Button type="submit" disabled={submitting}>
          {(step.submitLabel !== undefined &&
            resolveDisplayText(step.submitLabel, locale)) ||
            t("platform.flowSubmit", "Continue")}
        </Button>
      </CancelFooter>
    </form>
  );
}

function BrowserStepView({
  step,
  submitting,
  callbackInput,
  setCallbackInput,
  onSubmitStep,
  onDismiss,
}: {
  readonly step: Extract<ConfigFlowStep, { kind: "browser" }>;
  readonly submitting: boolean;
  readonly callbackInput: string;
  readonly setCallbackInput: (value: string) => void;
  readonly onSubmitStep: StepSubmitHandler;
  readonly onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <Button
        type="button"
        variant="outline"
        className="gap-2"
        onClick={() => {
          void openExternalUrl(step.authorizeUrl).then((ok) => {
            if (!ok) {
              emitToast(
                "error",
                t("platform.openExternalFailed", "Could not open external URL"),
              );
            }
          });
        }}
      >
        <ExternalLink className="h-4 w-4" />
        {t("platform.openInBrowser", "Open authorization page")}
      </Button>
      {step.completion !== "paste" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>
            {t(
              "platform.waitingCallback",
              "Waiting for authorization callback...",
            )}
          </span>
        </div>
      )}
      {step.completion !== "loopback" && (
        <form
          noValidate
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!callbackInput.trim()) return;
            void onSubmitStep({
              stepId: step.stepId,
              callbackUrl: callbackInput.trim(),
            });
          }}
        >
          <label
            htmlFor="flow-callback-url"
            className="block text-xs font-medium text-muted-foreground"
          >
            {t(
              "platform.pasteCallbackUrl",
              "Or paste the redirected callback URL",
            )}
          </label>
          <div className="flex gap-2">
            <input
              id="flow-callback-url"
              type="url"
              value={callbackInput}
              onChange={(e) => setCallbackInput(e.target.value)}
              placeholder={step.callbackUrl ?? "http://127.0.0.1/..."}
              className="min-w-0 flex-1 rounded-(--radius-control) border border-input bg-background px-3 py-1.5 text-sm"
            />
            <Button
              type="submit"
              disabled={submitting || !callbackInput.trim()}
            >
              {t("platform.flowSubmit", "Continue")}
            </Button>
          </div>
        </form>
      )}
      <CancelFooter
        onDismiss={onDismiss}
        cancelLabel={t("common.cancel", "Cancel")}
      />
    </div>
  );
}

function DeviceStepView({
  step,
  onDismiss,
}: {
  readonly step: Extract<ConfigFlowStep, { kind: "device" }>;
  readonly onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 rounded-(--radius-control) border border-border bg-muted/40 px-4 py-3">
        <code className="text-lg font-mono font-semibold tracking-widest">
          {step.userCode}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={() => {
            const clipboard = navigator.clipboard;
            if (!clipboard?.writeText) {
              emitToast(
                "error",
                t("platform.copyFailed", "Could not copy to clipboard"),
              );
              return;
            }
            void clipboard
              .writeText(step.userCode)
              .then(() => {
                emitToast("info", t("platform.codeCopied", "Code copied"));
              })
              .catch(() => {
                emitToast(
                  "error",
                  t("platform.copyFailed", "Could not copy to clipboard"),
                );
              });
          }}
        >
          <Copy className="h-3.5 w-3.5" />
          {t("common.copy", "Copy")}
        </Button>
      </div>
      <Button
        type="button"
        variant="outline"
        className="gap-2"
        onClick={() =>
          void openExternalUrl(
            step.verificationUriComplete ?? step.verificationUri,
          )
        }
      >
        <ExternalLink className="h-4 w-4" />
        {t("platform.openVerificationPage", "Open verification page")}
      </Button>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>
          {t(
            "platform.pollingAuthorization",
            "Waiting for authorization confirmation...",
          )}
        </span>
      </div>
      <CancelFooter
        onDismiss={onDismiss}
        cancelLabel={t("common.cancel", "Cancel")}
      />
    </div>
  );
}

function ImportStepView({
  step,
  locale,
  submitting,
  importContent,
  setImportContent,
  importFilename,
  setImportFilename,
  setErrorMessage,
  onSubmitStep,
  onDismiss,
}: {
  readonly step: Extract<ConfigFlowStep, { kind: "import" }>;
  readonly locale: string | undefined;
  readonly submitting: boolean;
  readonly importContent: string;
  readonly setImportContent: (value: string) => void;
  readonly importFilename: string | undefined;
  readonly setImportFilename: (value: string | undefined) => void;
  readonly setErrorMessage: (message: string | null) => void;
  readonly onSubmitStep: StepSubmitHandler;
  readonly onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const reportTooLarge = () => {
    setErrorMessage(
      t("platform.importTooLarge", {
        maxBytes: step.maxBytes,
        defaultValue: "Content exceeds {{maxBytes}} bytes",
      }),
    );
  };
  return (
    <form
      noValidate
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!importContent) return;
        if (
          step.maxBytes !== undefined &&
          new TextEncoder().encode(importContent).byteLength > step.maxBytes
        ) {
          reportTooLarge();
          return;
        }
        void onSubmitStep({
          stepId: step.stepId,
          data: {
            content: importContent,
            ...(importFilename ? { filename: importFilename } : {}),
          },
        });
      }}
    >
      <input
        type="file"
        accept={step.accept}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          if (step.maxBytes !== undefined && file.size > step.maxBytes) {
            reportTooLarge();
            return;
          }
          setErrorMessage(null);
          setImportFilename(file.name);
          void file.text().then((text) => setImportContent(text));
        }}
        className="block w-full text-xs text-muted-foreground"
      />
      <textarea
        rows={5}
        value={importContent}
        onChange={(e) => setImportContent(e.target.value)}
        placeholder={
          step.placeholder !== undefined
            ? resolveDisplayText(step.placeholder, locale)
            : undefined
        }
        className="w-full rounded-(--radius-control) border border-input bg-background p-2.5 text-xs font-mono"
      />
      <CancelFooter
        onDismiss={onDismiss}
        cancelLabel={t("common.cancel", "Cancel")}
      >
        <Button type="submit" disabled={submitting || !importContent}>
          {t("platform.importSubmit", "Import")}
        </Button>
      </CancelFooter>
    </form>
  );
}

function ConfirmStepView({
  step,
  locale,
  submitting,
  onSubmitStep,
  onDismiss,
}: {
  readonly step: Extract<ConfigFlowStep, { kind: "confirm" }>;
  readonly locale: string | undefined;
  readonly submitting: boolean;
  readonly onSubmitStep: StepSubmitHandler;
  readonly onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      {step.details && step.details.length > 0 && (
        <dl className="space-y-1.5 rounded-(--radius-control) border border-border bg-muted/30 p-3 text-xs">
          {step.details.map((row, idx) => (
            <div key={idx} className="flex justify-between gap-4">
              <dt className="text-muted-foreground">
                {resolveDisplayText(row.label, locale)}
              </dt>
              <dd className="font-mono">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <CancelFooter
        onDismiss={onDismiss}
        cancelLabel={
          (step.cancelLabel !== undefined &&
            resolveDisplayText(step.cancelLabel, locale)) ||
          t("common.cancel", "Cancel")
        }
      >
        <Button
          type="button"
          variant={step.destructive ? "destructive" : "default"}
          disabled={submitting}
          onClick={() =>
            void onSubmitStep({
              stepId: step.stepId,
              data: { confirmed: true },
            })
          }
        >
          {(step.confirmLabel !== undefined &&
            resolveDisplayText(step.confirmLabel, locale)) ||
            t("platform.confirmAction", "Confirm")}
        </Button>
      </CancelFooter>
    </div>
  );
}

export function ConfigFlowDialog() {
  const { activeConfigFlow } = usePlatformUiState();
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;

  const [run, setRun] = useState<ConfigFlowRunSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [callbackInput, setCallbackInput] = useState("");
  const [importContent, setImportContent] = useState("");
  const [importFilename, setImportFilename] = useState<string | undefined>();

  const notifiedDoneRunRef = useRef<string | null>(null);
  const activeRunRef = useRef<ConfigFlowRunSnapshot | null>(null);
  const activeFlowKeyRef = useRef<number | undefined>(undefined);
  const lastStepKeyRef = useRef<string | null>(null);
  const cancelledRunIdsRef = useRef<Set<string>>(new Set());
  activeRunRef.current = run;

  const flowKey = activeConfigFlow?.key;
  activeFlowKeyRef.current = flowKey;

  const clearStepInputs = () => {
    setFormValues({});
    setCallbackInput("");
    setImportContent("");
    setImportFilename(undefined);
  };

  const resetStepInputs = () => {
    lastStepKeyRef.current = null;
    clearStepInputs();
  };

  const cancelRunOnce = (pluginId: string, flowId: string, runId: string) => {
    if (cancelledRunIdsRef.current.has(runId)) return Promise.resolve();
    cancelledRunIdsRef.current.add(runId);
    return Promise.resolve(
      cancelPluginConfigFlow(pluginId, flowId, runId),
    ).catch(() => {});
  };

  const applyRun = (nextRun: ConfigFlowRunSnapshot) => {
    const nextStepId = "stepId" in nextRun.step ? nextRun.step.stepId : "";
    const nextStepKey = `${nextRun.runId}:${nextRun.step.kind}:${nextStepId}`;
    const stepChanged = lastStepKeyRef.current !== nextStepKey;
    lastStepKeyRef.current = nextStepKey;

    setRun(nextRun);
    if (nextRun.step.kind === "done") {
      clearStepInputs();
      if (notifiedDoneRunRef.current !== nextRun.runId) {
        notifiedDoneRunRef.current = nextRun.runId;
        bumpPlatformInstanceDataVersion();
      }
    } else if (stepChanged) {
      clearStepInputs();
      if (nextRun.step.kind === "form") {
        setFormValues(initFormValues(nextRun.step.fields));
      }
    }
  };

  useEffect(() => {
    if (!activeConfigFlow) {
      setRun(null);
      setErrorMessage(null);
      setLoading(false);
      setSubmitting(false);
      resetStepInputs();
      return;
    }
    let cancelled = false;
    setRun(null);
    setErrorMessage(null);
    setLoading(true);
    setSubmitting(false);
    resetStepInputs();

    const startedFlow = activeConfigFlow;

    void startPluginConfigFlow(
      startedFlow.pluginId,
      startedFlow.flowId,
      startedFlow.initial,
    )
      .then(async ({ run: startedRun }) => {
        if (!cancelled) {
          applyRun(startedRun);
        } else if (startedRun.status === "active") {
          await cancelRunOnce(
            startedFlow.pluginId,
            startedFlow.flowId,
            startedRun.runId,
          );
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setErrorMessage(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      const current = activeRunRef.current;
      if (
        current &&
        current.status === "active" &&
        current.pluginId === startedFlow.pluginId &&
        current.flowId === startedFlow.flowId
      ) {
        void cancelRunOnce(
          startedFlow.pluginId,
          startedFlow.flowId,
          current.runId,
        );
      }
    };
  }, [flowKey]);

  const step = run?.step;
  const stepKind = step?.kind;
  const stepId = step && "stepId" in step ? step.stepId : undefined;
  const stepCompletion =
    step?.kind === "browser" ? step.completion : undefined;
  const stepIntervalSec =
    step?.kind === "device" ? step.intervalSec : undefined;

  // Non-overlapping poll loop for active `device` and loopback-enabled `browser` steps.
  useEffect(() => {
    if (!activeConfigFlow || !run || run.status !== "active") return;
    const shouldPoll =
      stepKind === "device" ||
      (stepKind === "browser" && stepCompletion !== "paste");
    if (!shouldPoll) return;

    const intervalMs =
      stepKind === "device" ? (stepIntervalSec ?? 2) * 1000 : 2000;
    let cancelled = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;

    const schedule = () => {
      if (cancelled) return;
      timer = window.setTimeout(() => {
        if (cancelled) return;
        controller = new AbortController();
        void getPluginConfigFlowRun(
          activeConfigFlow.pluginId,
          activeConfigFlow.flowId,
          run.runId,
          controller.signal,
        )
          .then((res) => {
            if (!cancelled) applyRun(res.run);
          })
          .catch(() => {
            // Transient poll errors let the user still cancel or retry.
          })
          .finally(() => {
            controller = null;
            if (!cancelled) schedule();
          });
      }, intervalMs);
    };

    schedule();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [
    activeConfigFlow,
    run?.runId,
    run?.status,
    stepKind,
    stepId,
    stepCompletion,
    stepIntervalSec,
  ]);

  const dismiss = async () => {
    const req = activeConfigFlow;
    const current = activeRunRef.current;
    resetStepInputs();
    if (req && current && current.status === "active") {
      const cancelPromise = cancelRunOnce(
        req.pluginId,
        req.flowId,
        current.runId,
      );
      closePluginConfigFlow();
      await cancelPromise;
      return;
    }
    closePluginConfigFlow();
  };

  if (!activeConfigFlow) return null;

  const submitStep = async (payload: {
    readonly stepId: string;
    readonly data?: Record<string, unknown>;
    readonly callbackUrl?: string;
    readonly cancelled?: boolean;
  }) => {
    if (!run || submitting) return;
    const expectedFlowKey = flowKey;
    const expectedRunId = run.runId;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const res = await stepPluginConfigFlow(
        activeConfigFlow.pluginId,
        activeConfigFlow.flowId,
        run.runId,
        payload,
      );
      if (
        activeFlowKeyRef.current !== expectedFlowKey ||
        activeRunRef.current?.runId !== expectedRunId
      ) {
        return;
      }
      applyRun(res.run);
    } catch (err) {
      if (
        activeFlowKeyRef.current !== expectedFlowKey ||
        activeRunRef.current?.runId !== expectedRunId
      ) {
        return;
      }
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      if (activeFlowKeyRef.current === expectedFlowKey) {
        setSubmitting(false);
      }
    }
  };

  const title = step
    ? resolveDisplayText(step.title, locale) || activeConfigFlow.flowId
    : activeConfigFlow.flowId;

  const description =
    step && "description" in step && step.description !== undefined
      ? resolveDisplayText(step.description, locale)
      : "";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void dismiss();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : (
            <DialogDescription className="sr-only">
              {t("platform.flowDialogDescription", "Plugin configuration flow")}
            </DialogDescription>
          )}
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>
              {t("platform.flowLoading", "Starting configuration flow...")}
            </span>
          </div>
        )}

        {errorMessage && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        )}

        {!loading && run && step?.kind === "form" && (
          <FormStepView
            step={step}
            locale={locale}
            submitting={submitting}
            formValues={formValues}
            setFormValues={setFormValues}
            setErrorMessage={setErrorMessage}
            onSubmitStep={submitStep}
            onDismiss={() => void dismiss()}
          />
        )}

        {!loading && run && step?.kind === "browser" && (
          <BrowserStepView
            step={step}
            submitting={submitting}
            callbackInput={callbackInput}
            setCallbackInput={setCallbackInput}
            onSubmitStep={submitStep}
            onDismiss={() => void dismiss()}
          />
        )}

        {!loading && run && step?.kind === "device" && (
          <DeviceStepView step={step} onDismiss={() => void dismiss()} />
        )}

        {!loading && run && step?.kind === "import" && (
          <ImportStepView
            step={step}
            locale={locale}
            submitting={submitting}
            importContent={importContent}
            setImportContent={setImportContent}
            importFilename={importFilename}
            setImportFilename={setImportFilename}
            setErrorMessage={setErrorMessage}
            onSubmitStep={submitStep}
            onDismiss={() => void dismiss()}
          />
        )}

        {!loading && run && step?.kind === "confirm" && (
          <ConfirmStepView
            step={step}
            locale={locale}
            submitting={submitting}
            onSubmitStep={submitStep}
            onDismiss={() => void dismiss()}
          />
        )}

        {!loading && run && step?.kind === "done" && (
          <div className="space-y-4">
            {step.summary && Object.keys(step.summary).length > 0 && (
              <dl className="space-y-1 rounded-(--radius-control) border border-border bg-muted/30 p-3 text-xs">
                {Object.entries(step.summary).map(([key, value]) => (
                  <div key={key} className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">{key}</dt>
                    <dd className="font-mono">{String(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" onClick={() => closePluginConfigFlow()}>
                {t("common.close", "Close")}
              </Button>
            </div>
          </div>
        )}

        {!loading && (!run || step?.kind === "error") && (
          <div className="space-y-4">
            {step?.kind === "error" && (
              <p role="alert" className="text-sm text-destructive">
                {resolveDisplayText(step.message, locale)}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" onClick={() => closePluginConfigFlow()}>
                {t("common.close", "Close")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
