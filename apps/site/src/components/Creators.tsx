import { ArrowUpRight } from "lucide-react";
import type { Copy } from "../copy.js";
import { repoFile } from "../links.js";
import { container, SectionHeading } from "./ui.js";

// The zero-code example from docs/guide/plugin-authoring-zero-code.md, cut to
// the lines that show what a plugin declares.
const MANIFEST: readonly (readonly [string, string?])[] = [
  ["---", "muted"],
  ["id: observation"],
  ["kind: plugin"],
  ["requires: [narrative-engine@1]"],
  ["runtime:"],
  ["  type: agent"],
  ["  schedule:"],
  ["    stage: post-turn"],
  ["    trigger: { type: scheduled, interval: 1 }"],
  ["  io:"],
  ["    inputs:"],
  ["      narrative:"],
  ["        from: { contract: narrative-engine@1 }"],
  ["    visibility: plugin"],
  ["---", "muted"],
  ["Describe one detail the player can observe", "prose"],
  ["in the latest narrative.", "prose"],
];

function ManifestLine({ text, tone }: { text: string; tone?: string }) {
  if (tone === "muted") return <span className="text-white/35">{text}</span>;
  if (tone === "prose") return <span className="text-white/80">{text}</span>;
  const colon = text.indexOf(":");
  if (colon < 0) return <span>{text}</span>;
  return (
    <>
      <span className="text-[oklch(83%_0.09_200)]">{text.slice(0, colon)}</span>
      <span className="text-white/40">:</span>
      <span className="text-[oklch(82%_0.12_70)]">{text.slice(colon + 1)}</span>
    </>
  );
}

export function Creators({ copy }: { copy: Copy }) {
  return (
    <section
      id="creators"
      aria-labelledby="creators-title"
      className="border-t border-line bg-raised/40 py-24 sm:py-32"
    >
      <div className={`${container} grid items-center gap-12 lg:grid-cols-2`}>
        <div>
          <SectionHeading
            id="creators-title"
            eyebrow={copy.creators.eyebrow}
            title={copy.creators.title}
          >
            {copy.creators.body}
          </SectionHeading>
          <ul className="mt-8 flex flex-col gap-1">
            {copy.creators.links.map((link) => (
              <li key={link.href}>
                <a
                  href={repoFile(link.href)}
                  className="group inline-flex items-center gap-1.5 py-1.5 font-medium text-ink transition hover:text-accent"
                >
                  {link.label}
                  <ArrowUpRight className="h-4 w-4 text-muted transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-accent" />
                </a>
              </li>
            ))}
          </ul>
        </div>
        <figure className="overflow-hidden rounded-2xl border border-line bg-[oklch(17%_0.015_255)] shadow-xl shadow-black/20">
          <figcaption className="flex h-10 items-center border-b border-white/10 px-4 font-mono text-xs text-white/50">
            {copy.creators.fileLabel}
          </figcaption>
          <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-6 text-white/85">
            <code>
              {MANIFEST.map(([text, tone], index) => (
                <span key={index} className="block">
                  <ManifestLine text={text} tone={tone} />
                </span>
              ))}
            </code>
          </pre>
        </figure>
      </div>
    </section>
  );
}
