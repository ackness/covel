import { SkillInstall } from "./SkillInstall.js";
import {
  ArrowUpRight,
  Bot,
  Check,
  Code2,
  Feather,
  PackageCheck,
} from "lucide-react";
import type { Copy } from "../copy.js";
import { DOCS_URL, repoFile } from "../links.js";
import { container, SectionHeading } from "./ui.js";

/** A brief and package summary adapted from the app's AiWorldGenerator. */
export function Creation({ copy }: { copy: Copy }) {
  const text = copy.creation;
  const linkClass =
    "mt-auto inline-flex items-center gap-1.5 pt-6 text-sm font-medium text-accent hover:underline underline-offset-4";
  return (
    <section
      id="create"
      aria-labelledby="create-title"
      className="border-t border-line py-24 sm:py-32"
    >
      <div className={container}>
        <SectionHeading
          id="create-title"
          eyebrow={text.eyebrow}
          title={text.title}
        >
          {text.body}
        </SectionHeading>
        <div className="mt-12 grid gap-5 lg:grid-cols-2">
          <article className="flex flex-col rounded-2xl border border-line bg-raised p-6 sm:p-8">
            <Bot className="size-6 text-accent" aria-hidden />
            <h3 className="mt-4 font-display text-2xl font-semibold">
              {text.app.title}
            </h3>
            <p className="mt-4 text-sm leading-relaxed text-muted">
              {text.app.body}
            </p>
            <div className="mt-6 overflow-hidden rounded-xl border border-line bg-page">
              <div className="preview-toolbar">
                <span>
                  <Bot size={14} aria-hidden />
                  {text.app.label}
                </span>
              </div>
              <div className="p-5">
                <p className="preview-label">{text.app.promptLabel}</p>
                <blockquote className="mt-2 font-display text-base leading-relaxed">
                  {text.app.prompt}
                </blockquote>
                <ol className="mt-5 flex flex-wrap gap-x-4 gap-y-2 border-y border-line py-3">
                  {text.app.steps.map((step) => (
                    <li
                      key={step}
                      className="inline-flex items-center gap-1 text-[11px] text-muted"
                    >
                      <Check size={12} className="text-accent" aria-hidden />
                      {step}
                    </li>
                  ))}
                </ol>
                <p className="mt-4 flex items-center gap-2 text-sm font-medium">
                  <PackageCheck className="size-4 text-accent" aria-hidden />
                  {text.app.result}
                </p>
                <ul className="mt-3 flex flex-wrap gap-2">
                  {text.app.parts.map((part) => (
                    <li
                      key={part}
                      className="rounded-md border border-line bg-raised px-2 py-1 text-[11px] text-muted"
                    >
                      {part}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <a
              className={linkClass}
              href={`${DOCS_URL}${copy.meta.docsPath}worlds/index.html`}
            >
              {text.app.link}
              <ArrowUpRight size={14} aria-hidden />
            </a>
          </article>
          <article className="flex flex-col rounded-2xl border border-line bg-raised p-6 sm:p-8">
            <Code2 className="size-6 text-accent" aria-hidden />
            <h3 className="mt-4 font-display text-2xl font-semibold">
              {text.skills.title}
            </h3>
            <p className="mt-4 text-sm leading-relaxed text-muted">
              {text.skills.body}
            </p>
            <SkillInstall copy={copy} />
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <a
                href={repoFile(".claude/skills/create-world/SKILL.md")}
                className="group border-t border-line pt-4 transition hover:text-accent"
              >
                <span className="flex items-center justify-between font-mono text-xs text-accent">
                  create-world
                  <ArrowUpRight size={14} aria-hidden />
                </span>
                <h4 className="mt-3 flex items-center gap-2 text-sm font-semibold">
                  <Feather size={14} aria-hidden />
                  {text.skills.worldTitle}
                </h4>
                <p className="mt-2 text-xs leading-relaxed text-muted">
                  {text.skills.worldBody}
                </p>
                <span className="mt-3 block text-xs text-accent">
                  {text.skills.sourceLabel} ↗
                </span>
              </a>
              <a
                href={repoFile(".claude/skills/create-plugin/SKILL.md")}
                className="group border-t border-line pt-4 transition hover:text-accent"
              >
                <span className="flex items-center justify-between font-mono text-xs text-accent">
                  create-plugin
                  <ArrowUpRight size={14} aria-hidden />
                </span>
                <h4 className="mt-3 flex items-center gap-2 text-sm font-semibold">
                  <Code2 size={14} aria-hidden />
                  {text.skills.pluginTitle}
                </h4>
                <p className="mt-2 text-xs leading-relaxed text-muted">
                  {text.skills.pluginBody}
                </p>
                <span className="mt-3 block text-xs text-accent">
                  {text.skills.sourceLabel} ↗
                </span>
              </a>
            </div>
            <p className="mt-4 text-xs leading-relaxed text-muted">
              {text.skills.note}
            </p>
            <a
              className={linkClass}
              href={`${DOCS_URL}${copy.meta.docsPath}internals/skills.html`}
            >
              {text.skills.link}
              <ArrowUpRight size={14} aria-hidden />
            </a>
          </article>
        </div>
      </div>
    </section>
  );
}
