import { useTranslation } from "react-i18next";
import { useActiveStep } from "@/hooks/use-active-step";

interface Step {
  key: string;
  index: string;
  titleKey: string;
  titleFallback: string;
  bodyKey: string;
  bodyFallback: string;
  glyph: string;
  detailKey: string;
  detailFallback: string;
}

const STEPS: readonly Step[] = [
  {
    key: "trigger",
    index: "01",
    titleKey: "home.pipeline.triggerTitle",
    titleFallback: "Trigger Router",
    bodyKey: "home.pipeline.triggerBody",
    bodyFallback:
      "Player input, tick events, and follow-ups all enter through one router that decides which runtimes wake up.",
    glyph: ">",
    detailKey: "home.pipeline.triggerDetail",
    detailFallback: "input arrives → 4 runtimes match",
  },
  {
    key: "context",
    index: "02",
    titleKey: "home.pipeline.contextTitle",
    titleFallback: "Context Assembly",
    bodyKey: "home.pipeline.contextBody",
    bodyFallback:
      "A 10-slice prompt builder pulls world lore, recent events, character state, and plugin-specific data — cached at the right boundary.",
    glyph: "{ }",
    detailKey: "home.pipeline.contextDetail",
    detailFallback: "prompt: 8.3k tokens · 71% cache hit",
  },
  {
    key: "runtime",
    index: "03",
    titleKey: "home.pipeline.runtimeTitle",
    titleFallback: "Runtime Runner",
    bodyKey: "home.pipeline.runtimeBody",
    bodyFallback:
      "The agent runtime drives an LLM tool-call loop. Each plugin gets only the tools it declared — nothing more.",
    glyph: "·~·",
    detailKey: "home.pipeline.runtimeDetail",
    detailFallback: "claude-sonnet-4-6 · streaming…",
  },
  {
    key: "proposals",
    index: "04",
    titleKey: "home.pipeline.proposalsTitle",
    titleFallback: "Proposals",
    bodyKey: "home.pipeline.proposalsBody",
    bodyFallback:
      "Plugins never write to the DB. They emit typed proposals — narrative, state patch, record, render — that the kernel validates.",
    glyph: "△",
    detailKey: "home.pipeline.proposalsDetail",
    detailFallback: "narrative.append · state.patch · ui.render",
  },
  {
    key: "commit",
    index: "05",
    titleKey: "home.pipeline.commitTitle",
    titleFallback: "Validate & Commit",
    bodyKey: "home.pipeline.commitBody",
    bodyFallback:
      "Hooks gate every write. Once cleared, the commit service writes atomically and emits SSE events for the UI.",
    glyph: "✓",
    detailKey: "home.pipeline.commitDetail",
    detailFallback: "5 hooks passed · 12ms commit",
  },
  {
    key: "render",
    index: "06",
    titleKey: "home.pipeline.renderTitle",
    titleFallback: "Render",
    bodyKey: "home.pipeline.renderBody",
    bodyFallback:
      "json-render walks the spec into React. Plugin panels react to data changes without the framework knowing they exist.",
    glyph: "◐",
    detailKey: "home.pipeline.renderDetail",
    detailFallback: "narrative streamed · 3 panels updated",
  },
];

interface Props {
  scrollRoot: HTMLElement | null;
}

export function PipelineScrolly({ scrollRoot }: Props) {
  const { t } = useTranslation();
  const [setStepRef, active] = useActiveStep(STEPS.length, scrollRoot);

  return (
    <section
      aria-labelledby="pipeline-heading"
      className="relative w-full bg-background border-t border-border"
    >
      <div className="max-w-350 mx-auto px-6 md:px-10 py-20 md:py-28">
        <header className="max-w-3xl mb-16 md:mb-24">
          <span className="ui-eyebrow text-muted-foreground">
            {t("home.pipeline.eyebrow", "One turn, six stations")}
          </span>
          <h2
            id="pipeline-heading"
            className="font-display text-4xl md:text-6xl font-bold tracking-tight mt-4 leading-[1.05]"
          >
            {t(
              "home.pipeline.title",
              "What happens between your message and the next paragraph.",
            )}
          </h2>
          <p className="mt-6 text-lg text-muted-foreground font-light leading-relaxed">
            {t(
              "home.pipeline.subtitle",
              "Each turn passes through a fixed pipeline. Plugins plug in at every station; the kernel never improvises.",
            )}
          </p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-8 md:gap-12">
          {/* Sticky panel — visualisation. */}
          <div className="md:col-span-6 md:order-2">
            <div className="md:sticky md:top-24 md:h-[60vh] flex items-center justify-center">
              <div
                className="relative w-full aspect-square max-w-md rounded-(--radius-card) border border-border bg-card overflow-hidden"
                style={{
                  background:
                    "radial-gradient(ellipse at top, color-mix(in oklab, var(--color-primary) 8%, transparent) 0%, var(--surface-panel-strong) 60%)",
                }}
              >
                <ol
                  className="absolute inset-0 grid grid-cols-3 grid-rows-2 gap-px p-px"
                  aria-label={t(
                    "home.pipeline.diagramAria",
                    "Turn pipeline stages",
                  )}
                >
                  {STEPS.map((step, i) => {
                    const isActive = i === active;
                    const isPast = i < active;
                    return (
                      <li
                        key={step.key}
                        className="flex flex-col justify-between p-4 md:p-5 transition-all duration-500 ease-out"
                        style={{
                          background: isActive
                            ? "color-mix(in oklab, var(--color-primary) 12%, var(--surface-panel-strong))"
                            : isPast
                              ? "color-mix(in oklab, var(--color-primary) 4%, var(--surface-panel-strong))"
                              : "var(--surface-panel-strong)",
                          opacity: isActive ? 1 : isPast ? 0.85 : 0.55,
                        }}
                      >
                        <div className="flex items-center justify-between">
                          <span className="ui-eyebrow text-muted-foreground/80">
                            {step.index}
                          </span>
                          <span
                            className={`h-1.5 w-1.5 rounded-full transition-colors ${
                              isActive
                                ? "bg-primary"
                                : isPast
                                  ? "bg-primary/40"
                                  : "bg-muted"
                            }`}
                          />
                        </div>
                        <div
                          className="font-mono text-3xl md:text-4xl mt-3 transition-colors"
                          style={{
                            color: isActive
                              ? "var(--color-primary)"
                              : isPast
                                ? "color-mix(in oklab, var(--color-primary) 60%, var(--color-muted-foreground))"
                                : "color-mix(in oklab, var(--color-muted-foreground) 60%, transparent)",
                          }}
                        >
                          {step.glyph}
                        </div>
                        <p className="text-[11px] font-medium uppercase tracking-wider mt-2 text-foreground/90 leading-tight">
                          {t(step.titleKey, step.titleFallback)}
                        </p>
                      </li>
                    );
                  })}
                </ol>
              </div>
            </div>
          </div>

          {/* Scrolling text steps. */}
          <ol className="md:col-span-6 md:order-1 space-y-[40vh] md:space-y-[55vh] py-[15vh]">
            {STEPS.map((step, i) => {
              const isActive = i === active;
              return (
                <li
                  key={step.key}
                  ref={setStepRef(i)}
                  className="transition-opacity duration-300"
                  style={{ opacity: isActive ? 1 : 0.45 }}
                >
                  <div className="flex items-baseline gap-4 mb-4">
                    <span className="ui-eyebrow text-primary">
                      {step.index}
                    </span>
                    <span
                      aria-hidden="true"
                      className="h-px flex-1 bg-border"
                    />
                  </div>
                  <h3 className="font-display text-3xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.05]">
                    {t(step.titleKey, step.titleFallback)}
                  </h3>
                  <p className="text-base md:text-lg text-muted-foreground font-light leading-relaxed mb-4 max-w-prose">
                    {t(step.bodyKey, step.bodyFallback)}
                  </p>
                  <p className="font-mono text-xs text-foreground/70 px-3 py-2 inline-block bg-muted/50 border border-border rounded-(--radius-control)">
                    {t(step.detailKey, step.detailFallback)}
                  </p>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}
