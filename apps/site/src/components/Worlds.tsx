import { Ecosystem } from "./Ecosystem.js";
import { LanguageFeature } from "./LanguageFeature.js";
import type { Copy } from "../copy.js";
import { asset } from "../links.js";
import { container, SectionHeading } from "./ui.js";
import { useEntrance } from "./use-entrance.js";

export function Worlds({ copy }: { copy: Copy }) {
  const gallery = useEntrance<HTMLUListElement>();
  return (
    <section
      id="worlds"
      aria-labelledby="worlds-title"
      className="border-t border-line py-24 sm:py-32"
    >
      <div className={container}>
        <SectionHeading
          id="worlds-title"
          eyebrow={copy.worlds.eyebrow}
          title={copy.worlds.title}
        >
          {copy.worlds.body}
        </SectionHeading>
        <ul
          ref={gallery}
          className="reveal-group mt-14 grid gap-6 sm:grid-cols-2"
        >
          {copy.worlds.list.map((world, index) => (
            <li
              key={world.id}
              className="world-card group overflow-hidden rounded-2xl border border-line bg-raised"
            >
              <div className="relative aspect-16/10 overflow-hidden">
                <img
                  src={asset(`worlds/${world.id}.webp`)}
                  alt=""
                  width={960}
                  height={640}
                  loading="lazy"
                  className="world-art size-full object-cover"
                />
                <span
                  aria-hidden
                  className="absolute top-4 left-4 flex size-8 items-center justify-center rounded-full border border-line bg-raised font-mono text-[10px] text-muted"
                >
                  {String(index + 1).padStart(2, "0")}
                </span>
              </div>
              <div className="p-6 sm:p-7">
                <p className="text-[11px] font-medium tracking-wide text-accent">
                  {world.genre}
                </p>
                <h3 className="mt-3 font-display text-2xl font-semibold text-balance">
                  {world.name}
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-muted">
                  {world.summary}
                </p>
              </div>
            </li>
          ))}
        </ul>
        <LanguageFeature copy={copy} />
        <Ecosystem copy={copy} />
      </div>
    </section>
  );
}
