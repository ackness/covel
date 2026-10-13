import { ArrowUpRight } from "lucide-react";
import type { Copy, Item } from "../copy.js";
import { asset, repoFile } from "../links.js";
import { container, SectionHeading } from "./ui.js";

// The zero-code example from docs/plugins/prompt-only.md, cut to
// the lines that show what a plugin declares.
const MANIFEST: readonly (readonly [string, string?])[] = [
  ["---", "muted"],
  ["id: observation"],
  ["kind: plugin"],
  ["requires: [narrative-engine@1]"],
  ["runtime:"],
  ["  type: agent"],
  ["  schedule: { stage: post-turn }"],
  ["  io: { visibility: plugin }"],
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

function Pillar({
  number,
  title,
  points,
  children,
}: {
  number: string;
  title: string;
  points: readonly Item[];
  children: React.ReactNode;
}) {
  return (
    <article className="group flex flex-col overflow-hidden rounded-3xl border border-line bg-raised transition hover:border-accent/40">
      <div className="relative aspect-[16/10] overflow-hidden border-b border-line">
        {children}
      </div>
      <div className="flex flex-1 flex-col p-6 sm:p-8">
        <h3 className="flex items-baseline gap-3 font-display text-2xl font-semibold tracking-tight">
          <span className="font-mono text-sm text-accent">{number}</span>
          {title}
        </h3>
        <dl className="mt-6 flex flex-col gap-5">
          {points.map((point) => (
            <div key={point.title} className="border-l-2 border-accent/40 pl-4">
              <dt className="font-semibold tracking-tight">{point.title}</dt>
              <dd className="mt-1.5 text-sm leading-relaxed text-muted">
                {point.body}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </article>
  );
}

export function Pillars({ copy }: { copy: Copy }) {
  const { pillars } = copy;
  return (
    <section
      id="features"
      aria-labelledby="features-title"
      className="border-t border-line py-24 sm:py-32"
    >
      <div className={container}>
        <SectionHeading
          id="features-title"
          eyebrow={pillars.eyebrow}
          title={pillars.title}
        />
        <div className="mt-14 grid gap-5 lg:grid-cols-2">
          <Pillar
            number="01"
            title={pillars.plugin.title}
            points={pillars.plugin.points}
          >
            <div className="flex h-full flex-col bg-[oklch(17%_0.015_255)]">
              <p className="flex h-9 shrink-0 items-center border-b border-white/10 px-4 font-mono text-[11px] text-white/50">
                plugins/observation/PLUGIN.md
              </p>
              <pre className="overflow-hidden p-4 font-mono text-[11px] leading-5 text-white/85 sm:p-5 sm:text-[13px] sm:leading-6">
                <code>
                  {MANIFEST.map(([text, tone], index) => (
                    <span key={index} className="block">
                      <ManifestLine text={text} tone={tone} />
                    </span>
                  ))}
                </code>
              </pre>
            </div>
          </Pillar>
          <Pillar
            number="02"
            title={pillars.world.title}
            points={pillars.world.points}
          >
            <img
              src={asset("screens/world-package-builder.webp")}
              alt={pillars.worldAlt}
              loading="lazy"
              className="h-full w-full object-cover object-top transition duration-700 group-hover:scale-[1.02]"
            />
          </Pillar>
        </div>
        <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-1">
          {pillars.links.map((link) => (
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
    </section>
  );
}
