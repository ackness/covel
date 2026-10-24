import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Copy } from "../copy.js";
import { DownloadButtons } from "./DownloadButtons.js";
import { REPO_URL } from "../links.js";
import { Showcase } from "./Showcase.js";
import { container } from "./ui.js";
import { version } from "../../package.json";

/** How long each way to play stays on screen before the next one. */
export const BEAT_MS = 4000;
export const MODE_MS = BEAT_MS * 3;

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

export function Hero({ copy }: { copy: Copy }) {
  const modes = copy.hero.modes;
  const [active, setActive] = useState(0);
  const [previous, setPrevious] = useState(-1);
  const [beat, setBeat] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [still, setStill] = useState(false);
  const [visible, setVisible] = useState(true);
  const hero = useRef<HTMLElement>(null);

  // Reduced motion leaves scene selection manual.
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      setStill(query.matches);
    };
    apply();
    query.addEventListener("change", apply);
    return () => {
      query.removeEventListener("change", apply);
    };
  }, []);

  useEffect(() => {
    if (!hero.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setVisible(entry?.isIntersecting ?? false);
      },
      { threshold: 0.1 },
    );
    observer.observe(hero.current);
    return () => observer.disconnect();
  }, []);

  const show = (index: number) => {
    if (index === active) return;
    setBeat(0);
    setPrevious(active);
    setActive(index);
  };

  useEffect(() => {
    if (paused || hovered || still || !visible) return;
    // One clock drives the scene's three moments and the next world. Pausing
    // preserves the selected moment; resuming gives it a full reading interval.
    const timers: number[] = [];
    for (let next = beat + 1; next < 3; next++) {
      timers.push(
        window.setTimeout(() => setBeat(next), (next - beat) * BEAT_MS),
      );
    }
    timers.push(
      window.setTimeout(
        () => show((active + 1) % modes.length),
        (3 - beat) * BEAT_MS,
      ),
    );
    return () => timers.forEach(window.clearTimeout);
  }, [active, beat, paused, hovered, still, visible, modes.length]);

  const mode = modes[active] ?? modes[0];
  if (!mode) return null;

  return (
    <section
      id="top"
      ref={hero}
      className="grain relative"
      aria-labelledby="hero-title"
      data-mode={mode.visual}
    >
      <div className={`${container} pt-10 pb-20 sm:pt-14 lg:pt-16`}>
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
          <DownloadButtons copy={copy} />
          <p className="mt-5 text-xs text-muted">{copy.hero.note}</p>
        </div>
        <div className="mx-auto mt-10 max-w-5xl sm:mt-12">
          <div className="showcase-controls">
            <p className="showcase-caption">{copy.preview.label}</p>
            <div
              role="tablist"
              aria-label={copy.hero.modesLabel}
              className="showcase-tabs"
              onMouseEnter={() => setHovered(true)}
              onMouseLeave={() => setHovered(false)}
            >
              {modes.map((item, index) => (
                <button
                  key={item.visual}
                  type="button"
                  role="tab"
                  id={`mode-${item.visual}`}
                  aria-controls="mode-preview"
                  tabIndex={index === active ? 0 : -1}
                  onFocus={() => setPaused(true)}
                  onKeyDown={(event) => {
                    const next =
                      event.key === "ArrowRight"
                        ? (index + 1) % modes.length
                        : event.key === "ArrowLeft"
                          ? (index - 1 + modes.length) % modes.length
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? modes.length - 1
                              : undefined;
                    if (next === undefined) return;
                    event.preventDefault();
                    show(next);
                    document
                      .getElementById(`mode-${modes[next]?.visual}`)
                      ?.focus();
                  }}
                  aria-selected={index === active}
                  onClick={() => {
                    setPaused(true);
                    show(index);
                  }}
                  className="showcase-tab"
                >
                  <span className="showcase-tab-number" aria-hidden>
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  {item.word.replace(/\.$/, "")}
                  {index === active &&
                  !paused &&
                  !hovered &&
                  !still &&
                  visible ? (
                    <span
                      key={`${active}-${beat}`}
                      aria-hidden
                      className="absolute inset-x-3 bottom-0.5 h-px origin-left bg-(--mode)"
                      style={{
                        animation: `journey-progress-${beat} ${(3 - beat) * BEAT_MS}ms linear forwards`,
                      }}
                    />
                  ) : null}
                </button>
              ))}
            </div>
            {!still && (
              <div className="showcase-play">
                <button
                  type="button"
                  onClick={() => setPaused((value) => !value)}
                  aria-label={paused ? copy.hero.play : copy.hero.pause}
                  className="inline-flex size-9 items-center justify-center rounded-full border border-line text-muted transition hover:text-ink"
                >
                  {paused ? (
                    <Play size={12} aria-hidden />
                  ) : (
                    <Pause size={12} aria-hidden />
                  )}
                </button>
              </div>
            )}
          </div>
          <div
            onFocus={() => setPaused(true)}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          >
            <Showcase
              copy={copy}
              visual={mode.visual}
              beat={beat}
              onBeat={(next) => {
                setPaused(true);
                setBeat(next);
              }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
