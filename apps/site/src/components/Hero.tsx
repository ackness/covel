import { useEffect, useState } from "react";
import type { Copy } from "../copy.js";
import type { DownloadLinks } from "../download.js";
import { DownloadButtons } from "./DownloadButtons.js";
import { REPO_URL } from "../links.js";
import { Showcase } from "./Showcase.js";
import { container } from "./ui.js";
import { version } from "../../package.json";

/** How long each way to play stays on screen before the next one. */
export const MODE_MS = 3600;

/**
 * Stacks every word in one grid cell so the line keeps the width of the
 * longest and nothing below it jumps. The active word's letters rise into
 * place one after another while the previous word's letters drift up and
 * blur away.
 */
function RotatingWord({
  words,
  active,
  previous,
}: {
  words: readonly string[];
  active: number;
  previous: number;
}) {
  return (
    <span className="grid justify-items-center">
      {words.map((word, index) => {
        const state =
          index === active ? "in" : index === previous ? "out" : "wait";
        return (
          <span
            key={word}
            aria-hidden={state !== "in"}
            className="mode-word col-start-1 row-start-1"
            data-state={state}
          >
            {Array.from(word).map((letter, at) => (
              <span
                key={at}
                className="mode-letter"
                style={{ transitionDelay: `${at * 35}ms` }}
              >
                {letter === " " ? " " : letter}
              </span>
            ))}
          </span>
        );
      })}
    </span>
  );
}

export function Hero({
  copy,
  download,
}: {
  copy: Copy;
  download: DownloadLinks;
}) {
  const modes = copy.hero.modes;
  const [active, setActive] = useState(0);
  const [previous, setPrevious] = useState(-1);
  const [paused, setPaused] = useState(false);
  const [still, setStill] = useState(false);

  // A visitor who asked for reduced motion picks a mode by hand.
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setStill(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  const show = (index: number) => {
    if (index === active) return;
    setPrevious(active);
    setActive(index);
  };

  useEffect(() => {
    if (paused || still) return;
    const timer = window.setTimeout(
      () => show((active + 1) % modes.length),
      MODE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [active, paused, still, modes.length]);

  const mode = modes[active] ?? modes[0];
  if (!mode) return null;

  return (
    <section
      id="top"
      className="grain relative"
      aria-labelledby="hero-title"
      data-mode={mode.visual}
    >
      <div className={`${container} pt-14 pb-20 sm:pt-20 lg:pt-24`}>
        <div className="mx-auto max-w-4xl text-center">
          <a
            href={`${REPO_URL}/releases`}
            className="inline-flex items-center gap-2 rounded-full border border-line bg-raised/60 px-3 py-1 text-xs text-muted backdrop-blur transition hover:text-ink"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-ember" aria-hidden />
            {copy.hero.badge}
            <span className="font-mono text-ink">v{version}</span>
          </a>
          <p className="mt-6 font-mono text-xs tracking-[0.2em] text-muted uppercase sm:text-sm">
            {copy.hero.tagline}
          </p>
          <h1
            id="hero-title"
            className="mt-4 font-display text-[2.4rem] leading-[1.1] font-semibold tracking-tight text-balance sm:text-6xl lg:text-7xl"
          >
            <span className="block">{copy.hero.lead}</span>
            <span className="sr-only">{mode.word}</span>
            <span aria-hidden className="block">
              <RotatingWord
                words={modes.map((item) => item.word)}
                active={active}
                previous={previous}
              />
            </span>
          </h1>
          <div className="mx-auto mt-6 grid max-w-2xl">
            {modes.map((item, index) => (
              <p
                key={item.visual}
                aria-hidden={index !== active}
                className={`col-start-1 row-start-1 text-base leading-relaxed text-pretty text-muted transition-[opacity,translate,filter] duration-700 sm:text-lg ${
                  index === active
                    ? "translate-y-0 opacity-100 blur-0 delay-200"
                    : "pointer-events-none translate-y-2 opacity-0 blur-[2px]"
                }`}
              >
                {item.body}
              </p>
            ))}
          </div>
          <div
            role="tablist"
            aria-label={copy.hero.modesLabel}
            className="mt-7 grid grid-cols-2 gap-1 rounded-3xl border border-line bg-raised/60 p-1 backdrop-blur sm:inline-flex sm:rounded-full"
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
          >
            {modes.map((item, index) => (
              <button
                key={item.visual}
                type="button"
                role="tab"
                aria-selected={index === active}
                onClick={() => show(index)}
                className={`relative overflow-hidden rounded-full px-3.5 py-1.5 text-xs transition sm:text-sm ${
                  index === active
                    ? "bg-ink/8 text-ink"
                    : "text-muted hover:text-ink"
                }`}
              >
                {item.word.replace(/\.$/, "")}
                {index === active && !paused && !still ? (
                  <span
                    key={active}
                    aria-hidden
                    className="absolute inset-x-3 bottom-0.5 h-px origin-left bg-(--mode)"
                    style={{
                      animation: `fill ${MODE_MS}ms linear forwards`,
                    }}
                  />
                ) : null}
              </button>
            ))}
          </div>
          <DownloadButtons copy={copy} download={download} />
          <p className="mt-5 text-xs text-muted">{copy.hero.note}</p>
        </div>
        <div
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
        >
          <Showcase copy={copy} visual={mode.visual} />
        </div>
      </div>
    </section>
  );
}
