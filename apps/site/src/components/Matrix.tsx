import { useEffect, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { PLUGIN_IDS, type Copy, type Visual } from "../copy.js";
import { PACKS } from "../packs.js";
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
  ["  schedule: { stage: post-turn }"],
  ["  io: { visibility: plugin }"],
  ["---", "muted"],
  ["Describe one detail the player can observe", "prose"],
  ["in the latest narrative.", "prose"],
];

const SCREENS: Partial<Record<Visual, string>> = {
  world: "/screens/world-package-builder.webp",
  stage: "/screens/stage-mode.webp",
  tabletop: "/screens/rpg-systems.webp",
  story: "/screens/text-mode.webp",
};

const GREETINGS = ["你好，旅人。", "Hello, traveller.", "Здравствуй, путник."];

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

function Manifest({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-col bg-[oklch(17%_0.015_255)]">
      <p className="flex h-9 shrink-0 items-center border-b border-white/10 px-4 font-mono text-[11px] text-white/50">
        {label}
      </p>
      <pre className="overflow-hidden p-4 font-mono text-[11px] leading-5 text-white/85 sm:text-[12.5px] sm:leading-6">
        <code>
          {MANIFEST.map(([text, tone], index) => (
            <span key={index} className="block">
              <ManifestLine text={text} tone={tone} />
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

/** Cycles a greeting through the three interface languages. */
function Languages({ copy, active }: { copy: Copy; active: boolean }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(
      () => setIndex((value) => (value + 1) % GREETINGS.length),
      1600,
    );
    return () => window.clearInterval(timer);
  }, [active]);
  return (
    <div className="grain flex h-full flex-col items-center justify-center gap-5 bg-raised px-6">
      <p
        key={index}
        className="animate-[fade-up_500ms_ease-out] font-display text-2xl font-semibold sm:text-4xl"
      >
        {GREETINGS[index]}
      </p>
      <ul className="flex flex-wrap justify-center gap-2">
        {copy.matrix.languages.map((language, at) => (
          <li
            key={language}
            className={`rounded-full border px-3 py-1 text-xs transition duration-500 sm:text-sm ${
              at === index
                ? "border-accent bg-accent/15 text-ink"
                : "border-line text-muted"
            }`}
          >
            {language}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Scene({
  copy,
  visual,
  active,
}: {
  copy: Copy;
  visual: Visual;
  active: boolean;
}) {
  const screen = SCREENS[visual];
  let content;
  if (visual === "plugin") content = <Manifest label={copy.matrix.codeLabel} />;
  else if (visual === "languages")
    content = <Languages copy={copy} active={active} />;
  else if (screen)
    content = (
      <img
        src={screen}
        alt={copy.matrix.imageAlt[visual as keyof Copy["matrix"]["imageAlt"]]}
        className="h-full w-full object-cover object-top"
        loading="lazy"
      />
    );
  return (
    <div
      aria-hidden={!active}
      className={`absolute inset-0 transition duration-700 ${
        active
          ? "scale-100 opacity-100"
          : "pointer-events-none scale-[1.03] opacity-0"
      }`}
    >
      {content}
    </div>
  );
}

/** The plugin list that lights up the set the current step runs. */
function Rack({ copy, visual }: { copy: Copy; visual: Visual }) {
  const on = new Set(PACKS[visual]);
  return (
    <div className="border-t border-line p-3 sm:p-4">
      <div className="flex items-baseline justify-between gap-3 text-[11px] sm:text-xs">
        <p className="font-mono uppercase tracking-[0.16em] text-muted">
          {copy.rack.label}{" "}
          <span className="text-accent tabular-nums">
            {on.size}/{PLUGIN_IDS.length}
          </span>
        </p>
        <p
          key={visual}
          className="animate-[fade-up_400ms_ease-out] truncate text-ink"
        >
          {copy.rack.packs[visual]}
        </p>
      </div>
      <ul className="mt-2.5 flex flex-wrap gap-1.5" data-testid="plugin-rack">
        {PLUGIN_IDS.map((id, index) => {
          const lit = on.has(id);
          return (
            <li
              key={id}
              data-on={lit}
              style={{ transitionDelay: `${index * 28}ms` }}
              className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-all duration-300 sm:px-2.5 sm:py-1 sm:text-xs ${
                lit
                  ? "border-accent/50 bg-accent/12 text-ink"
                  : "border-line text-muted/50"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full transition-all duration-300 ${
                  lit
                    ? "bg-accent shadow-[0_0_8px_var(--accent)]"
                    : "bg-muted/30"
                }`}
              />
              {copy.rack.names[id]}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The feature chapters scroll past a sticky panel. Whichever step crosses the
 * middle of the screen picks the scene the panel shows and the plugins it
 * switches on.
 */
export function Matrix({ copy }: { copy: Copy }) {
  const steps = copy.matrix.chapters.flatMap((chapter, chapterIndex) =>
    chapter.steps.map((step, stepIndex) => ({
      ...step,
      chapter: stepIndex === 0 ? chapter.title : undefined,
      number: chapterIndex + 1,
    })),
  );
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = refs.current.indexOf(entry.target as HTMLLIElement);
          if (index >= 0) setActive(index);
        }
      },
      { rootMargin: "-62% 0px -36% 0px" },
    );
    for (const element of refs.current) if (element) observer.observe(element);
    return () => observer.disconnect();
  }, [steps.length]);

  const visual = steps[active]?.visual ?? "plugin";
  const visuals = [...new Set(steps.map((step) => step.visual))];

  return (
    <section
      id="features"
      aria-labelledby="features-title"
      className="border-t border-line py-24 sm:py-32"
    >
      <div className={container}>
        <SectionHeading
          id="features-title"
          eyebrow={copy.matrix.eyebrow}
          title={copy.matrix.title}
        />
        <div className="mt-12 grid gap-x-14 lg:mt-16 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
          <div className="sticky top-16 z-10 -mx-5 bg-page px-5 pt-3 pb-4 after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-10 after:bg-linear-to-b after:from-page after:to-transparent lg:after:hidden sm:-mx-8 sm:px-8 lg:order-2 lg:top-24 lg:mx-0 lg:self-start lg:bg-transparent lg:p-0">
            <figure className="overflow-hidden rounded-2xl border border-line bg-raised shadow-2xl shadow-black/20 lg:rounded-3xl">
              <div className="relative aspect-[16/9] overflow-hidden lg:aspect-[16/10]">
                {visuals.map((item) => (
                  <Scene
                    key={item}
                    copy={copy}
                    visual={item}
                    active={item === visual}
                  />
                ))}
              </div>
              <Rack copy={copy} visual={visual} />
            </figure>
          </div>
          <ol className="lg:order-1">
            {steps.map((step, index) => (
              <li
                key={`${step.number}-${step.visual}`}
                ref={(element) => {
                  refs.current[index] = element;
                }}
                data-active={index === active}
                className={`flex min-h-[70vh] flex-col justify-center py-10 transition-opacity duration-500 lg:min-h-[85vh] ${
                  index === active ? "opacity-100" : "opacity-35"
                }`}
              >
                {step.chapter ? (
                  <h3 className="flex items-baseline gap-3 font-display text-2xl font-semibold tracking-tight sm:text-3xl">
                    <span className="font-mono text-sm text-accent">
                      {String(step.number).padStart(2, "0")}
                    </span>
                    {step.chapter}
                  </h3>
                ) : null}
                <dl className="mt-6 flex flex-col gap-6">
                  {step.points.map((point) => (
                    <div
                      key={point.title}
                      className="border-l-2 border-accent/40 pl-4"
                    >
                      <dt className="text-lg font-semibold tracking-tight">
                        {point.title}
                      </dt>
                      <dd className="mt-2 leading-relaxed text-muted">
                        {point.body}
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ol>
        </div>
        <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-1">
          {copy.matrix.links.map((link) => (
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
