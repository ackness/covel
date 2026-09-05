import { useEffect, useState } from "react";
import {
  lookupModelCapabilityDetails,
  type ModelCapabilityLookupResult,
} from "@/services/api.js";

export function useModelCapability(
  model: string,
  provider: string,
  protocol: string | undefined,
) {
  const targetKey = JSON.stringify([model, provider, protocol]);
  const [lookup, setLookup] = useState<{
    targetKey: string;
    result: ModelCapabilityLookupResult | null;
  }>();
  useEffect(() => {
    let active = true;
    if (model) {
      void lookupModelCapabilityDetails(model, provider, protocol)
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
  }, [model, provider, protocol, targetKey]);
  return lookup?.targetKey === targetKey ? lookup.result : undefined;
}
