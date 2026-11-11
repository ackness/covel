import { useEffect, useMemo, useState } from "react";
import {
  lookupModelCapabilityDetails,
  type ModelCapabilityInfo,
  type ModelCapabilityLookupResult,
} from "@/services/api.js";

/** Resolve catalogue facts once per model configuration, shared by all role rows. */
export function useModelCapabilities<
  T extends {
    provider: string;
    scope?: string;
    baseUrl?: string;
    model?: string;
    protocol?: string;
    capability?: ModelCapabilityInfo;
  },
>(
  models: readonly T[],
  revision?: string,
): Array<T & { serverCredentialsAvailable?: boolean }> {
  const keyFor = (model: T) =>
    JSON.stringify([
      model.provider,
      model.model,
      model.protocol ?? null,
      model.scope === "custom" ? (model.baseUrl ?? "") : null,
    ]);
  const pending = [
    ...new Set(
      models
        .filter(
          (model) =>
            model.model && (!model.capability || model.scope === "custom"),
        )
        .map(keyFor),
    ),
  ];
  const requestKey = JSON.stringify([pending, revision]);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    lookups: Record<string, ModelCapabilityLookupResult>;
  }>();
  useEffect(() => {
    let active = true;
    void Promise.all(
      pending.map(async (key) => {
        const [provider, model, protocol, baseUrl] = JSON.parse(key) as [
          string,
          string,
          string | null,
          string | null,
        ];
        try {
          const result = await lookupModelCapabilityDetails(
            model,
            provider,
            protocol ?? undefined,
            undefined,
            baseUrl === null ? undefined : { baseUrl, revision },
          );
          return [key, result] as const;
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (active)
        setSnapshot({
          key: requestKey,
          lookups: Object.fromEntries(
            results.filter((result) => result !== null),
          ),
        });
    });
    return () => {
      active = false;
    };
  }, [requestKey]);
  return useMemo(
    () =>
      models.map((model) => {
        const lookup =
          snapshot?.key === requestKey
            ? snapshot.lookups[keyFor(model)]
            : undefined;
        return {
          ...model,
          capability: model.capability ?? lookup?.capability,
          ...(model.scope === "custom"
            ? { serverCredentialsAvailable: lookup?.serverCredentialsAvailable }
            : {}),
        };
      }),
    [models, snapshot, requestKey],
  );
}
