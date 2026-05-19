import React from "react";
import i18n from "@/i18n";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallbackMessage?: string;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

const copyToClipboard = async (text: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to legacy path
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
};

abstract class BaseBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false, error: undefined };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  protected handleReset = (): void => {
    this.setState({ hasError: false, error: undefined });
    this.props.onReset?.();
  };

  protected handleCopy = (): void => {
    const err = this.state.error;
    if (!err) return;
    const payload = `${err.name}: ${err.message}\n\n${err.stack ?? "(no stack)"}`;
    void copyToClipboard(payload);
  };

  protected handleReload = (): void => {
    window.location.reload();
  };
}

/**
 * Inline boundary for a single message bubble. Small visual footprint,
 * retry/copy inline, doesn't take over the viewport.
 */
export class MessageErrorBoundary extends BaseBoundary {
  render() {
    if (this.state.hasError) {
      const msg =
        this.state.error?.message ??
        this.props.fallbackMessage ??
        i18n.t("error.boundary.messageRenderingError", {
          defaultValue: "Message rendering error",
        });
      return (
        <div className="p-3 text-xs border border-destructive/50 bg-destructive/5 text-destructive space-y-2">
          <div className="font-medium">
            {this.props.fallbackMessage ??
              i18n.t("error.boundary.messageRenderingError", {
                defaultValue: "Message rendering error",
              })}
          </div>
          <div className="font-mono text-[11px] break-all opacity-80">
            {msg}
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={this.handleReset}
              className="px-2 py-1 text-[11px] border border-destructive/40 hover:bg-destructive/10 transition-colors"
            >
              {i18n.t("common.retry", { defaultValue: "Retry" })}
            </button>
            <button
              onClick={this.handleCopy}
              className="px-2 py-1 text-[11px] border border-destructive/40 hover:bg-destructive/10 transition-colors"
            >
              {i18n.t("error.boundary.copyError", {
                defaultValue: "Copy error",
              })}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Full-page boundary for the app root. Prevents a single failing subtree
 * from whiting out the entire app.
 */
export class AppErrorBoundary extends BaseBoundary {
  render() {
    if (this.state.hasError) {
      const err = this.state.error;
      return (
        <div className="flex items-center justify-center min-h-screen w-full p-6 bg-background text-foreground">
          <div className="max-w-lg w-full border border-border p-8 space-y-6">
            <div className="space-y-2">
              <div className="text-[11px] font-mono uppercase tracking-widest text-destructive">
                {i18n.t("error.boundary.unexpectedError", {
                  defaultValue: "Unexpected error",
                })}
              </div>
              <h1 className="text-xl font-display font-bold">
                {i18n.t("error.boundary.appTitle", {
                  defaultValue: "Something broke while rendering this view.",
                })}
              </h1>
              <p className="text-sm text-muted-foreground">
                {i18n.t("error.boundary.appDescription", {
                  defaultValue:
                    "Try the actions below. If the problem persists, copy the error and open an issue.",
                })}
              </p>
            </div>
            {err && (
              <pre className="text-[11px] font-mono bg-muted/40 border border-border p-3 max-h-40 overflow-auto">
                {err.name}: {err.message}
              </pre>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={this.handleReset}
                className="px-3 py-2 text-xs uppercase tracking-widest border border-primary bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {i18n.t("error.boundary.tryAgain", {
                  defaultValue: "Try again",
                })}
              </button>
              <button
                onClick={this.handleReload}
                className="px-3 py-2 text-xs uppercase tracking-widest border border-border hover:bg-muted"
              >
                {i18n.t("error.boundary.reloadApp", {
                  defaultValue: "Reload app",
                })}
              </button>
              <button
                onClick={this.handleCopy}
                className="px-3 py-2 text-xs uppercase tracking-widest border border-border hover:bg-muted"
              >
                {i18n.t("error.boundary.copyError", {
                  defaultValue: "Copy error",
                })}
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
