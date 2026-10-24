import { ArrowUpRight } from "lucide-react";
import { repoFile } from "../links.js";
import { PLUGIN_IDS, type Copy, type Visual } from "../copy.js";
import { MOMENT_PLUGINS, WORLD_IDS, PACKS } from "../packs.js";
import { PreviewScene } from "./PreviewScenes.js";

/** The plugin list that lights up the set a way to play runs. */
function Rack({
  copy,
  visual,
  beat,
}: {
  copy: Copy;
  visual: Visual;
  beat: number;
}) {
  const on = new Set(PACKS[visual]);
  const focused = new Set(MOMENT_PLUGINS[visual][beat]);
  return (
    <div className="border-t border-line p-3 sm:px-5 sm:py-4">
      <div className="flex items-baseline justify-between gap-3 text-[11px] sm:text-xs">
        <p className="font-mono tracking-[0.16em] text-muted uppercase">
          {copy.rack.label}{" "}
          <span className="text-(--mode) tabular-nums transition-colors duration-700">
            {on.size}
          </span>
        </p>
        <p
          key={visual}
          className="animate-[rise_500ms_ease-out] truncate text-ink"
        >
          {copy.rack.packs[visual]}
        </p>
      </div>
      <ul className="mt-2.5 flex flex-wrap gap-1.5" data-testid="plugin-rack">
        {PLUGIN_IDS.map((id, index) => {
          const lit = on.has(id);
          return (
            <li
              key={id}
              data-on={lit}
              data-current={focused.has(id)}
              data-plugin={id}
              style={{ transitionDelay: `${index * 30}ms` }}
              className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-all duration-500 sm:px-2.5 sm:py-1 sm:text-xs ${
                lit
                  ? "border-(--mode)/50 bg-(--mode)/12 text-ink"
                  : "border-line text-muted"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full transition-all duration-500 ${
                  lit ? "bg-(--mode) " : "bg-muted/30"
                }`}
              />
              {copy.rack.names[id]}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Editable HTML scenes share the page language and theme tokens. */
export function Showcase({
  copy,
  visual,
  beat,
  onBeat,
}: {
  copy: Copy;
  visual: Visual;
  beat: number;
  onBeat: (beat: number) => void;
}) {
  return (
    <figure className="showcase-frame relative">
      <div className="overflow-hidden rounded-2xl border border-line bg-raised">
        <div className="preview-toolbar">
          <span>
            <span className="preview-frame-index" aria-hidden>
              {String(
                copy.hero.modes.findIndex((mode) => mode.visual === visual) + 1,
              ).padStart(2, "0")}{" "}
              / {String(copy.hero.modes.length).padStart(2, "0")}
            </span>
            <span className="preview-frame-title">
              {copy.preview[visual].title}
            </span>
          </span>
          <span>{copy.preview.example}</span>
        </div>
        <div
          id="mode-preview"
          role="tabpanel"
          tabIndex={0}
          aria-labelledby={`mode-${visual}`}
          className="preview-deck"
        >
          {copy.hero.modes.map((mode) => (
            <div
              key={mode.visual}
              className="preview-scene"
              data-active={mode.visual === visual}
              aria-hidden={mode.visual !== visual}
              inert={mode.visual !== visual}
            >
              <PreviewScene
                copy={copy}
                visual={mode.visual}
                beat={mode.visual === visual ? beat : 0}
              />
            </div>
          ))}
        </div>
        <div className="preview-journey">
          <div className="preview-journey-heading">
            <p>{copy.journey.label}</p>
            <a href={repoFile(`worlds/${WORLD_IDS[visual]}/world.yaml`)}>
              {copy.journey.source}
              <ArrowUpRight size={12} aria-hidden />
            </a>
          </div>
          <div
            className="preview-moments"
            role="group"
            aria-label={copy.journey.label}
          >
            {copy.journey[visual].map((moment, index) => (
              <button
                key={index}
                type="button"
                aria-pressed={beat === index}
                onClick={() => onBeat(index)}
              >
                <span className="preview-moment-number">0{index + 1}</span>
                <span>{moment.title}</span>
              </button>
            ))}
          </div>
          <div className="preview-moment-caption">
            <p>{copy.journey[visual][beat]?.body}</p>
            <span>
              {MOMENT_PLUGINS[visual][beat]
                ?.map((id) => copy.rack.names[id])
                .join(" · ")}
            </span>
          </div>
        </div>
        <Rack copy={copy} visual={visual} beat={beat} />
      </div>
    </figure>
  );
}
