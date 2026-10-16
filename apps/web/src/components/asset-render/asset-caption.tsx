import type { ReactNode } from "react";
import type { AssetGenerateView } from "@covel/shared";

export function readAssetPrompt(
  meta: AssetGenerateView["meta"],
): string | null {
  const prompt = meta?.prompt;
  return typeof prompt === "string" && prompt.length > 0 ? prompt : null;
}

export function AssetCaption({
  view,
  className,
  children,
}: {
  view: AssetGenerateView;
  className: string;
  children: ReactNode;
}) {
  const title = readAssetPrompt(view.meta) ?? view.modality;
  const subtitle = view.source.runtimeId;
  return (
    <figure className={`${className} flex flex-col gap-1.5 w-full`}>
      <figcaption className="ui-eyebrow text-[10px] font-mono uppercase tracking-wider text-muted-foreground/80 flex flex-wrap items-baseline gap-x-2">
        <span className="text-foreground/80">{title}</span>
        {subtitle ? <span className="opacity-60">· {subtitle}</span> : null}
      </figcaption>
      {children}
    </figure>
  );
}
