import { ArrowRight, Download, Gamepad2 } from "lucide-react";
import type { Copy } from "../copy.js";
import { REPO_URL, TRIAL_URL } from "../links.js";
import { primaryButton, secondaryButton } from "./ui.js";

export function DownloadButtons({ copy }: { copy: Copy }) {
  return (
    <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
      <a href="#downloads" className={primaryButton}>
        <Download size={16} aria-hidden />
        {copy.hero.primary}
      </a>
      <a href={TRIAL_URL} className={secondaryButton}>
        <Gamepad2 size={16} aria-hidden />
        {copy.hero.trial}
      </a>
      <a href={REPO_URL} className={secondaryButton}>
        {copy.hero.secondary}
        <ArrowRight size={16} aria-hidden />
      </a>
    </div>
  );
}
