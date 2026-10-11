import type { Copy } from "../copy.js";
import { container, SectionHeading } from "./ui.js";

export function CorePlugins({ copy }: { copy: Copy }) {
  return (
    <section
      id="plugins"
      aria-labelledby="plugins-title"
      className="border-t border-line bg-raised/40 py-24 sm:py-32"
    >
      <div className={container}>
        <SectionHeading
          id="plugins-title"
          eyebrow={copy.core.eyebrow}
          title={copy.core.title}
        >
          {copy.core.body}
        </SectionHeading>
        <ul className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {copy.core.items.map((item) => (
            <li
              key={item.ids}
              className="group rounded-2xl border border-line bg-raised p-6 transition hover:-translate-y-0.5 hover:border-accent/50"
            >
              <span aria-hidden className="text-2xl">
                {item.icon}
              </span>
              <h3 className="mt-4 text-lg font-semibold tracking-tight">
                {item.title}
              </h3>
              <p className="mt-1 font-mono text-[11px] text-accent">
                {item.ids}
              </p>
              <p className="mt-3 text-sm leading-relaxed text-muted">
                {item.body}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
