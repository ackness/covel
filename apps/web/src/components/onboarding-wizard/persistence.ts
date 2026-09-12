import { getSettings } from "@/settings/store.js";
import { ONBOARDING_VERSION } from "./constants.js";

export function isOnboarded(): boolean {
  const stored = getSettings().get<number>("ui.onboardedVersion");
  return typeof stored === "number" && stored >= ONBOARDING_VERSION;
}

export function markOnboarded(): void {
  void getSettings().set("ui.onboardedVersion", ONBOARDING_VERSION);
}

/** Show the guide on its next mount without changing connection settings. */
export function resetOnboarding(): void {
  void getSettings().clear("ui.onboardedVersion");
}
