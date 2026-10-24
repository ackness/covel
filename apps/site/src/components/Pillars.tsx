import {
  ArrowUpRight,
  Blocks,
  Feather,
  FileText,
  FolderOpen,
} from "lucide-react";
import type { Copy, Item } from "../copy.js";
import { DOCS_URL } from "../links.js";
import { container, SectionHeading } from "./ui.js";

function Points({ items }: { items: readonly Item[] }) {
  return (
    <dl className="mt-6 grid gap-5">
      {items.map((item) => (
        <div key={item.title}>
          <dt className="text-sm font-semibold">{item.title}</dt>
          <dd className="mt-1.5 text-sm leading-relaxed text-muted">
            {item.body}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Pillars({ copy }: { copy: Copy }) {
  const { pillars } = copy;
  return (
    <section
      id="features"
      aria-labelledby="features-title"
      className="border-t border-line py-24 sm:py-32"
    >
      <div className={container}>
        <SectionHeading
          id="features-title"
          eyebrow={pillars.eyebrow}
          title={pillars.title}
        >
          {pillars.body}
        </SectionHeading>
        <div className="mt-12 grid gap-5 lg:grid-cols-2">
          <article className="rounded-2xl border border-line bg-raised p-6 sm:p-8">
            <div className="flex items-center gap-3">
              <Blocks className="size-5 text-accent" aria-hidden />
              <h3 className="font-display text-2xl font-semibold">
                {pillars.plugin.title}
              </h3>
            </div>
            <p className="mt-4 text-sm leading-relaxed text-muted">
              {pillars.plugin.body}
            </p>
            <div className="mt-6 rounded-xl border border-line bg-page p-5">
              <p className="flex items-center justify-center gap-2 rounded-lg border border-accent/30 bg-raised px-4 py-3 text-sm font-medium">
                <Feather className="size-4 text-accent" aria-hidden />
                {pillars.plugin.diagramTitle}
              </p>
              <div className="mx-auto h-5 w-px bg-line" aria-hidden />
              <ul className="grid grid-cols-2 gap-2">
                {pillars.plugin.modules.map((name) => (
                  <li
                    key={name}
                    className="rounded-lg border border-line bg-raised px-3 py-2 text-center text-xs text-muted"
                  >
                    {name}
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-center text-xs text-muted">
                {pillars.plugin.diagramNote}
              </p>
            </div>
            <Points items={pillars.plugin.points} />
          </article>
          <article className="rounded-2xl border border-line bg-raised p-6 sm:p-8">
            <div className="flex items-center gap-3">
              <FolderOpen className="size-5 text-accent" aria-hidden />
              <h3 className="font-display text-2xl font-semibold">
                {pillars.world.title}
              </h3>
            </div>
            <p className="mt-4 text-sm leading-relaxed text-muted">
              {pillars.world.body}
            </p>
            <div className="mt-6 rounded-xl border border-line bg-page p-5">
              <p className="mb-3 flex items-center gap-2 text-xs text-muted">
                <FolderOpen className="size-4" aria-hidden />
                {pillars.world.diagramTitle}
              </p>
              <ul className="flex flex-col gap-2">
                {pillars.world.files.map((file) => (
                  <li
                    key={file.path}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-raised px-3 py-1.5 text-xs"
                  >
                    <FileText
                      className="size-3 shrink-0 text-accent"
                      aria-hidden
                    />
                    <span className="font-mono">{file.path}</span>
                    <span className="ml-auto text-muted">{file.label}</span>
                  </li>
                ))}
              </ul>
            </div>
            <Points items={pillars.world.points} />
          </article>
        </div>
        <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2">
          {pillars.links.map((link) => (
            <li key={link.href}>
              <a
                href={`${DOCS_URL}${copy.meta.docsPath}${link.href}`}
                className="inline-flex items-center gap-1.5 py-1.5 text-sm font-medium hover:text-accent"
              >
                {link.label}
                <ArrowUpRight className="size-4" aria-hidden />
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
