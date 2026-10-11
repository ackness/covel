import type { Copy } from "../copy.js";
import { container, SectionHeading } from "./ui.js";

export function Play({ copy }: { copy: Copy }) {
  return (
    <section
      id="play"
      aria-labelledby="play-title"
      className="border-t border-line py-24 sm:py-32"
    >
      <div className={container}>
        <SectionHeading
          id="play-title"
          eyebrow={copy.play.eyebrow}
          title={copy.play.title}
        />
        <ol className="mt-14 grid gap-4 md:grid-cols-3">
          {copy.play.steps.map((step, index) => (
            <li
              key={step.title}
              className="relative rounded-2xl border border-line bg-raised p-7"
            >
              <span className="font-mono text-sm text-accent">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h3 className="mt-6 text-xl font-semibold tracking-tight">
                {step.title}
              </h3>
              <p className="mt-3 leading-relaxed text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
