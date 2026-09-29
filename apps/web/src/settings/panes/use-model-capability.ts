import { useEffect, useState } from "react";
import {
  lookupModelCapabilityDetails,
  type ModelCapabilityLookupResult,
} from "@/services/api.js";

export function useModelCapability(
  model: string,
  provider: string,
  protocol: string | undefined,
  catalogRevision?: string,
  role?: string,
) {
  const targetKey = JSON.stringify([
    model,
    provider,
    protocol,
    role,
    catalogRevision,
  ]);
  const [lookup, setLookup] = useState<{
    targetKey: string;
    result: ModelCapabilityLookupResult | null;
  }>();
  useEffect(() => {
    let active = true;
    if (model) {
      void lookupModelCapabilityDetails(model, provider, protocol, role)
        .then((result) => {
          if (active) setLookup({ targetKey, result });
        })
        .catch(() => {
          if (active) setLookup({ targetKey, result: null });
        });
    }
    return () => {
      active = false;
    };
  }, [model, provider, protocol, role, targetKey]);
  return lookup?.targetKey === targetKey ? lookup.result : undefined;
}
