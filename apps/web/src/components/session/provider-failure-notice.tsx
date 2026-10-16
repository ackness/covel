import { createContext, useContext, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import {
  getBuiltinProviderConnection,
  type SessionPlugin,
} from "@covel/shared";
import type { ResolvedSlot } from "@/hooks/use-slot-config.js";
import type { ExecutionStep } from "@/stores/session-store/types.js";
import { ActionableErrorNotice } from "@/components/shared/actionable-error-notice.js";
import { classifyActionableError } from "@/lib/actionable-error.js";
import { resolveTextRuntimeSlot } from "./session-prep/model-slot-helpers.js";

interface SessionModelUse {
  slotId: string;
  provider: string;
}

/** Declared uses stay distinct even when they fall back to the same text slot. */
export function sessionModelUses(
  plugins: readonly Pick<SessionPlugin, "active" | "hostState" | "runtimes">[],
  slots: readonly ResolvedSlot[],
  overrides: Readonly<Record<string, string>> = {},
): SessionModelUse[] {
  const uses = new Map<string, SessionModelUse>();
  for (const plugin of plugins) {
    if (!plugin.active || plugin.hostState === "error") continue;
    for (const runtime of plugin.runtimes) {
      if (!runtime.model) continue;
      const slotId =
        runtime.runtimeType === "agent"
          ? (overrides[runtime.id] ?? runtime.model)
          : runtime.model;
      const resolved = resolveTextRuntimeSlot(slots, slotId)?.slot;
      const provider = resolved?.preset?.provider ?? resolved?.serverProvider;
      if (provider) uses.set(slotId, { slotId, provider });
    }
  }
  return [...uses.values()];
}

export const SessionModelUsesContext = createContext<
  readonly SessionModelUse[]
>([]);

/** One explanation for setup, recovery, and individual failed task notices. */
export function ProviderFailureNotice({
  errorKind,
  failureTarget,
  ...props
}: ComponentProps<typeof ActionableErrorNotice> &
  Pick<ExecutionStep, "errorKind" | "failureTarget">) {
  const { t, i18n } = useTranslation();
  const uses = useContext(SessionModelUsesContext);
  const kind = classifyActionableError(props.error, errorKind);
  const accountFailure =
    !errorKind || ["auth", "quota", "rate_limited"].includes(errorKind);
  const accountKind = !accountFailure
    ? undefined
    : kind === "auth" || kind === "forbidden"
      ? kind
      : kind === "rate-limited"
        ? errorKind === "quota"
          ? "quota"
          : "rate_limited"
        : undefined;
  const provider = failureTarget?.provider;
  const providerLabel = provider
    ? (getBuiltinProviderConnection(provider)?.label ?? provider)
    : undefined;
  const affected =
    provider && accountKind
      ? uses.filter((use) => use.provider === provider)
      : [];
  const slots = new Intl.ListFormat(i18n.language).format(
    affected.map(({ slotId }) =>
      t(`session.modelUse.${slotId}`, { defaultValue: slotId }),
    ),
  );
  return (
    <>
      <ActionableErrorNotice
        {...props}
        summary={
          providerLabel && accountKind
            ? t(`session.providerFailure.${accountKind}`, {
                provider: providerLabel,
              })
            : undefined
        }
      />
      {affected.length > 1 && (
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {t(
            accountKind === "auth"
              ? "session.providerFailure.sharedKey"
              : "session.providerFailure.sharedAccount",
            {
              provider: providerLabel,
              count: affected.length,
              slots,
            },
          )}
        </p>
      )}
    </>
  );
}
