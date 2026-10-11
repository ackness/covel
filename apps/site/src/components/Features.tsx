import {
  Clapperboard,
  Dices,
  HardDrive,
  Languages,
  Orbit,
  ScanSearch,
  type LucideIcon,
} from "lucide-react";
import type { Copy } from "../copy.js";
import { container, SectionHeading } from "./ui.js";

// One icon per feature, in the order of `copy.features.items`.
const ICONS: readonly LucideIcon[] = [
  Orbit,
  Dices,
  Clapperboard,
  HardDrive,
  ScanSearch,
  Languages,
];

export function Features({ copy }: { copy: Copy }) {
  return (
    <section
      id="features"
      aria-labelledby="features-title"
      className="border-t border-line py-24 sm:py-32"
    >
      <div className={container}>
        <SectionHeading
          id="features-title"
          eyebrow={copy.features.eyebrow}
          title={copy.features.title}
        />
        <ul className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {copy.features.items.map((item, index) => {
            const Icon = ICONS[index] ?? Orbit;
            return (
              <li key={item.title} className="bg-page p-7 sm:p-8">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-accent/12 text-accent">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <h3 className="mt-5 text-lg font-semibold tracking-tight">
                  {item.title}
                </h3>
                <p className="mt-2 leading-relaxed text-muted">{item.body}</p>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
