import { useEffect, useState } from "react";
import { PLUGIN_IDS, type Copy, type Visual } from "../copy.js";
import { asset } from "../links.js";
import { PACKS } from "../packs.js";

const SCREENS: Record<Exclude<Visual, "languages">, string> = {
  stage: asset("screens/stage-mode.webp"),
  tabletop: asset("screens/rpg-systems.webp"),
  story: asset("screens/text-mode.webp"),
};

const GREETINGS = ["你好，旅人。", "Hello, traveller.", "Здравствуй, путник."];

/** Cycles a greeting through the three interface languages. */
function Languages({ copy, active }: { copy: Copy; active: boolean }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(
      () => setIndex((value) => (value + 1) % GREETINGS.length),
      1100,
    );
    return () => window.clearInterval(timer);
  }, [active]);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-raised bg-[radial-gradient(36rem_18rem_at_50%_45%,color-mix(in_oklch,var(--mode)_22%,transparent),transparent)] px-6">
      <p
        key={index}
        className="relative animate-[rise_600ms_cubic-bezier(.2,.8,.2,1)] font-display text-3xl font-semibold sm:text-5xl"
      >
        {GREETINGS[index]}
      </p>
      <ul className="relative flex flex-wrap justify-center gap-2">
        {copy.hero.languages.map((language, at) => (
          <li
            key={language}
            className={`rounded-full border px-3 py-1 text-xs transition duration-500 sm:text-sm ${
              at === index
                ? "border-(--mode) bg-(--mode)/15 text-ink"
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
  const alt = copy.hero.modes.find((mode) => mode.visual === visual)?.alt ?? "";
  return (
    <div
      aria-hidden={!active}
      className={`absolute inset-0 transition-[opacity,scale,filter] duration-700 ease-out ${
        active
          ? "scale-100 opacity-100 blur-0"
          : "pointer-events-none scale-[1.04] opacity-0 blur-sm"
      }`}
    >
      {visual === "languages" ? (
        <Languages copy={copy} active={active} />
      ) : (
        <img
          src={SCREENS[visual]}
          alt={alt}
          className="h-full w-full object-cover object-top"
        />
      )}
    </div>
  );
}

/** The plugin list that lights up the set a way to play runs. */
function Rack({ copy, visual }: { copy: Copy; visual: Visual }) {
  const on = new Set(PACKS[visual]);
  return (
    <div className="border-t border-line p-3 sm:px-5 sm:py-4">
      <div className="flex items-baseline justify-between gap-3 text-[11px] sm:text-xs">
        <p className="font-mono tracking-[0.16em] text-muted uppercase">
          {copy.rack.label}{" "}
          <span className="text-(--mode) tabular-nums transition-colors duration-700">
            {on.size}/{PLUGIN_IDS.length}
          </span>
        </p>
        <p
          key={visual}
          className="animate-[rise_500ms_ease-out] truncate text-ink"
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
              style={{ transitionDelay: `${index * 30}ms` }}
              className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-all duration-500 sm:px-2.5 sm:py-1 sm:text-xs ${
                lit
                  ? "border-(--mode)/50 bg-(--mode)/12 text-ink"
                  : "border-line text-muted/50"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full transition-all duration-500 ${
                  lit
                    ? "bg-(--mode) shadow-[0_0_8px_var(--mode)]"
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

/** The hero's picture: one scene per way to play, over the plugins it runs. */
export function Showcase({ copy, visual }: { copy: Copy; visual: Visual }) {
  return (
    <figure className="relative mx-auto mt-14 max-w-5xl">
      <div
        aria-hidden
        className="absolute -inset-x-8 -top-8 -bottom-4 -z-10 rounded-[3rem] bg-(--mode)/25 blur-3xl transition-colors duration-1000"
      />
      <div className="overflow-hidden rounded-2xl border border-line bg-raised shadow-2xl shadow-black/30 sm:rounded-3xl">
        <div className="relative aspect-[16/10] overflow-hidden sm:aspect-[16/9]">
          {copy.hero.modes.map((mode) => (
            <Scene
              key={mode.visual}
              copy={copy}
              visual={mode.visual}
              active={mode.visual === visual}
            />
          ))}
        </div>
        <Rack copy={copy} visual={visual} />
      </div>
    </figure>
  );
}
