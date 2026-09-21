import { useEffect, useMemo, useState } from "react";
import {
  lookupModelCapabilityDetails,
  type ModelCapabilityInfo,
} from "@/services/api.js";

/** Resolve catalogue facts once per model configuration, shared by all role rows. */
export function useModelCapabilities<
  T extends {
    provider: string;
    model?: string;
    protocol?: string;
    capability?: ModelCapabilityInfo;
  },
>(models: readonly T[], revision?: string): T[] {
  const keyFor = (model: T) =>
    JSON.stringify([model.provider, model.model, model.protocol]);
  const pending = [
    ...new Set(
      models.filter((model) => !model.capability && model.model).map(keyFor),
    ),
  ];
  const requestKey = JSON.stringify([pending, revision]);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    capabilities: Record<string, ModelCapabilityInfo>;
  }>();
  useEffect(() => {
    let active = true;
    void Promise.all(
      pending.map(async (key) => {
        const [provider, model, protocol] = JSON.parse(key) as [
          string,
          string,
          string | undefined,
        ];
        try {
          const result = await lookupModelCapabilityDetails(
            model,
            provider,
            protocol,
          );
          return [key, result.capability] as const;
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (active)
        setSnapshot({
          key: requestKey,
          capabilities: Object.fromEntries(
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
      models.map((model) => ({
        ...model,
        capability:
          model.capability ??
          (snapshot?.key === requestKey
            ? snapshot.capabilities[keyFor(model)]
            : undefined),
      })),
    [models, snapshot, requestKey],
  );
}
