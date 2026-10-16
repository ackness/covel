import { createContext, useContext, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  getBuiltinProviderConnection,
  type SessionPlugin,
} from "@covel/shared";
import type { ResolvedSlot } from "@/hooks/use-slot-config.js";
import type { ExecutionStep } from "@/stores/session-store/types.js";
import { ActionableErrorNotice } from "@/components/shared/actionable-error-notice.js";
import { classifyActionableError } from "@/lib/actionable-error.js";
import { resolveTextRuntimeSlot } from "./session-prep/model-slot-helpers.js";

export interface SessionModelUse {
  slotId: string;
  provider: string;
  hasCredentials?: boolean;
}

const USE_ORDER = ["story", "plugin", "utility", "fast", "memory"];

/** Name the uses for the player, the story first, in the UI language. */
export function formatModelUses(
  t: TFunction,
  language: string,
  slotIds: readonly string[],
): string {
  const rank = (slotId: string) => {
    const index = USE_ORDER.indexOf(slotId);
    return index === -1 ? USE_ORDER.length : index;
  };
  return new Intl.ListFormat(language).format(
    [...new Set(slotIds)]
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
      .map((slotId) =>
        t(`session.modelUse.${slotId}`, { defaultValue: slotId }),
      ),
  );
}

/** Declared uses stay distinct even when they fall back to the same text slot. */
export function sessionModelUses(
  plugins: readonly (Pick<SessionPlugin, "hostState" | "runtimes"> & {
    active?: boolean;
  })[],
  slots: readonly ResolvedSlot[],
  overrides: Readonly<Record<string, string>> = {},
): SessionModelUse[] {
  const uses = new Map<string, SessionModelUse>();
  for (const plugin of plugins) {
    if (plugin.active === false || plugin.hostState === "error") continue;
    for (const runtime of plugin.runtimes) {
      if (!runtime.model) continue;
      const slotId =
        runtime.runtimeType === "agent"
          ? (overrides[runtime.id] ?? runtime.model)
          : runtime.model;
      const resolved = resolveTextRuntimeSlot(slots, slotId)?.slot;
      const provider = resolved?.preset?.provider ?? resolved?.serverProvider;
      if (provider)
        uses.set(slotId, {
          slotId,
          provider,
          ...(resolved?.hasCredentials !== undefined
            ? { hasCredentials: resolved.hasCredentials }
            : {}),
        });
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
    !errorKind ||
    ["missing_key", "auth", "quota", "rate_limited"].includes(errorKind);
  const accountKind = !accountFailure
    ? undefined
    : errorKind === "missing_key"
      ? "missing_key"
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
  const slots = formatModelUses(
    t,
    i18n.language,
    affected.map(({ slotId }) => slotId),
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
            accountKind === "auth" || accountKind === "missing_key"
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
