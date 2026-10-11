import type { Copy } from "../copy.js";
import { container, SectionHeading } from "./ui.js";

export function Worlds({ copy }: { copy: Copy }) {
  return (
    <section
      id="worlds"
      aria-labelledby="worlds-title"
      className="border-t border-line bg-raised/40 py-24 sm:py-32"
    >
      <div className={container}>
        <SectionHeading
          id="worlds-title"
          eyebrow={copy.worlds.eyebrow}
          title={copy.worlds.title}
        >
          {copy.worlds.body}
        </SectionHeading>
        <ul className="mt-14 grid gap-5 sm:grid-cols-2">
          {copy.worlds.list.map((world) => (
            <li
              key={world.id}
              className="group relative isolate flex aspect-4/3 flex-col justify-end overflow-hidden rounded-2xl border border-line p-6 sm:aspect-3/2 sm:p-7"
            >
              <img
                src={`/worlds/${world.id}.webp`}
                alt=""
                width={960}
                height={640}
                loading="lazy"
                className="absolute inset-0 -z-20 h-full w-full object-cover transition duration-700 group-hover:scale-105"
              />
              <div
                aria-hidden
                className="absolute inset-0 -z-10 bg-linear-to-t from-black/90 via-black/45 to-black/0"
              />
              <span className="w-fit rounded-full border border-white/20 bg-black/30 px-2.5 py-1 text-[11px] tracking-wide text-white/85 backdrop-blur">
                {world.genre}
              </span>
              <h3 className="mt-3 font-display text-2xl font-semibold text-white">
                {world.name}
              </h3>
              <p className="mt-2 line-clamp-3 max-w-md text-sm leading-relaxed text-white/75">
                {world.summary}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
