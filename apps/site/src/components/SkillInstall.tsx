import { useState } from "react";
import { Check, Copy as CopyIcon, Terminal } from "lucide-react";
import type { Copy } from "../copy.js";

export const SKILL_INSTALL_COMMAND =
  "npx skills add ackness/covel --skill create-world --skill create-plugin";

export function SkillInstall({ copy }: { copy: Copy }) {
  const text = copy.creation.skills;
  const [status, setStatus] = useState<"copied" | "failed">();
  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(SKILL_INSTALL_COMMAND);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  };
  return (
    <div className="mt-5 rounded-xl border border-line bg-page p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-xs text-muted">
          <Terminal size={14} aria-hidden />
          {text.installTitle}
        </p>
        <button
          type="button"
          onClick={() => void copyCommand()}
          aria-label={text.copyCommand}
          title={text.copyCommand}
          className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-ink/5 hover:text-ink"
        >
          {status === "copied" ? (
            <Check size={15} aria-hidden />
          ) : (
            <CopyIcon size={15} aria-hidden />
          )}
        </button>
      </div>
      <code className="mt-2 block font-mono text-xs leading-7 whitespace-pre-wrap break-words text-ink select-all">
        {SKILL_INSTALL_COMMAND}
      </code>
      <p className="mt-3 text-xs leading-relaxed text-muted">
        {text.installNote}
      </p>
      <p role="status" className="mt-1 text-xs text-accent">
        {status === "copied"
          ? text.copied
          : status === "failed"
            ? text.copyFailed
            : ""}
      </p>
    </div>
  );
}
