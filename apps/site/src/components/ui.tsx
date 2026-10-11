import type { ReactNode } from "react";

export const container = "mx-auto w-full max-w-6xl px-5 sm:px-8";

const buttonBase =
  "inline-flex h-12 items-center justify-center gap-2 rounded-full px-6 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export const primaryButton = `${buttonBase} bg-accent text-accent-ink shadow-[0_10px_30px_-12px_var(--glow)] hover:brightness-110`;
export const secondaryButton = `${buttonBase} border border-line bg-raised/60 text-ink backdrop-blur hover:border-accent/60`;

export function SectionHeading({
  id,
  eyebrow,
  title,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="max-w-2xl">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent">
        {eyebrow}
      </p>
      <h2
        id={id}
        className="mt-4 font-display text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-5xl"
      >
        {title}
      </h2>
      {children ? (
        <p className="mt-5 text-base leading-relaxed text-muted sm:text-lg">
          {children}
        </p>
      ) : null}
    </header>
  );
}
