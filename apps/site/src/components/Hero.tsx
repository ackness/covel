import { useEffect, useRef } from "react";
import type { Copy } from "../copy.js";
import type { DownloadLinks } from "../download.js";
import { DownloadButtons } from "./DownloadButtons.js";
import { REPO_URL } from "../links.js";
import { container } from "./ui.js";
import { version } from "../../package.json";

export function Hero({
  copy,
  download,
}: {
  copy: Copy;
  download: DownloadLinks;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // A visitor who asked for reduced motion gets the poster frame only.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      if (query.matches) video.pause();
      else void video.play().catch(() => undefined);
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  return (
    <section id="top" className="grain relative" aria-labelledby="hero-title">
      <div className={`${container} pt-16 pb-20 sm:pt-24 lg:pt-28`}>
        <div className="mx-auto max-w-3xl text-center">
          <a
            href={`${REPO_URL}/releases`}
            className="inline-flex items-center gap-2 rounded-full border border-line bg-raised/60 px-3 py-1 text-xs text-muted backdrop-blur transition hover:text-ink"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-ember" aria-hidden />
            {copy.hero.badge}
            <span className="font-mono text-ink">v{version}</span>
          </a>
          <h1
            id="hero-title"
            className="mt-7 font-display text-[2.6rem] leading-[1.08] font-semibold tracking-tight text-balance sm:text-6xl lg:text-7xl"
          >
            <span className="block">{copy.hero.titleA}</span>
            <span className="block bg-linear-to-r from-accent to-ember bg-clip-text text-transparent">
              {copy.hero.titleB}
            </span>
          </h1>
          <p className="mx-auto mt-7 max-w-2xl text-base leading-relaxed text-pretty text-muted sm:text-lg">
            {copy.hero.body}
          </p>
          <DownloadButtons copy={copy} download={download} />
          <p className="mt-5 text-xs text-muted">{copy.hero.note}</p>
        </div>

        <figure className="relative mx-auto mt-16 max-w-5xl">
          <div
            aria-hidden
            className="absolute -inset-x-10 -top-10 -bottom-6 -z-10 rounded-[3rem] bg-accent/20 blur-3xl"
          />
          <div className="overflow-hidden rounded-2xl border border-line bg-raised shadow-2xl shadow-black/30">
            <video
              ref={videoRef}
              className="block aspect-[1152/720] h-auto w-full bg-black"
              src="/media/demo.mp4"
              poster="/media/demo-poster.jpg"
              width={1152}
              height={720}
              muted
              loop
              playsInline
              aria-label={copy.hero.videoLabel}
            />
          </div>
        </figure>
      </div>
    </section>
  );
}
