import { useTranslation } from "react-i18next";
import {
  getProviderPriceMultiplier,
  type ModelCapabilityInfo,
  type ModelCapabilityLookupResult,
} from "@/services/api.js";
import { CapabilityTags, formatPrice } from "./llm-capability-controls.js";
import { resolveDisplayCapability } from "./llm-effective-capability.js";

export function ResolvedCapability({
  lookup,
  provider,
  baseCapability,
  override,
}: {
  lookup: ModelCapabilityLookupResult | null | undefined;
  provider: string;
  baseCapability?: ModelCapabilityInfo | null;
  override?: Partial<ModelCapabilityInfo>;
}) {
  const { t } = useTranslation();
  const capability = resolveDisplayCapability(lookup, baseCapability, override);
  if (!capability)
    return (
      <p className="text-[10px] text-muted-foreground">
        {lookup === undefined
          ? "…"
          : t("settings.modelLimitsUnknown", {
              defaultValue: "Model limits unknown",
            })}
      </p>
    );
  const priceMultiplier = getProviderPriceMultiplier(provider);
  const inputPrice = capability.pricing?.inputPerMToken;
  const outputPrice = capability.pricing?.outputPerMToken;
  const imagePrice = capability.pricing?.perImage;

  return (
    <div className="space-y-1.5">
      <CapabilityTags capability={capability} />
      {lookup && (
        <div className="text-[10px] leading-relaxed text-muted-foreground">
          {lookup.matchKind && lookup.matchedModelId ? (
            <span>
              {t("settings.capabilityMatched", {
                model: lookup.matchedModelId,
                defaultValue: "Capabilities matched from {{model}}.",
              })}
            </span>
          ) : (
            <span>
              {t(
                "settings.capabilityUnknownHint",
                "No exact model record was found. Protocol support is estimated; model token limits are unknown unless explicitly overridden.",
              )}
            </span>
          )}
          {lookup.pricingKind === "reference" && (
            <span className="ml-1 text-amber-600">
              {t(
                "settings.referencePricing",
                "Pricing is a model reference; the provider's actual bill may differ.",
              )}
            </span>
          )}
        </div>
      )}
      {priceMultiplier !== 1 && capability.pricing && (
        <div className="border-l-2 border-primary/50 pl-2 text-[10px] text-muted-foreground">
          <span className="font-medium text-foreground">
            {t("settings.estimatedSettlementPrice", {
              multiplier: priceMultiplier,
              defaultValue: "Estimated settlement at ×{{multiplier}}: ",
            })}
          </span>
          {inputPrice != null && outputPrice != null
            ? `${formatPrice(inputPrice * priceMultiplier)} / ${formatPrice(outputPrice * priceMultiplier)}`
            : imagePrice != null
              ? `$${(imagePrice * priceMultiplier).toFixed(4)}/img`
              : "—"}
        </div>
      )}
    </div>
  );
}
