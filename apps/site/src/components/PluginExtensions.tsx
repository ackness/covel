import { ArrowUpRight, AudioLines, Blocks, ImagePlus } from "lucide-react";
import type { Copy } from "../copy.js";
import { DOCS_URL, PLUGIN_DIRECTORY_URL } from "../links.js";

export function PluginExtensions({ copy }: { copy: Copy }) {
  const text = copy.extensions;
  return (
    <aside
      className="mt-12 border-t border-line pt-8"
      aria-labelledby="extensions-title"
    >
      <h3 id="extensions-title" className="font-display text-2xl font-semibold">
        {text.title}
      </h3>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
        {text.body}
      </p>
      <div className="mt-7 grid gap-8 md:grid-cols-3">
        <article>
          <ImagePlus size={21} className="text-accent" aria-hidden />
          <h4 className="mt-3 text-sm font-semibold">{text.images.title}</h4>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            {text.images.body}
          </p>
          <div className="mt-4 flex flex-wrap gap-3 text-xs text-accent">
            {[
              { path: "openai-image-gen", name: "OpenAI Images" },
              { path: "dashscope-image-gen", name: "DashScope Images" },
            ].map((item) => (
              <a
                key={item.path}
                href={`${PLUGIN_DIRECTORY_URL}/tree/main/plugins/${item.path}`}
                className="inline-flex items-center gap-1 hover:underline underline-offset-4"
              >
                {item.name}
                <ArrowUpRight size={12} aria-hidden />
              </a>
            ))}
          </div>
        </article>
        <article>
          <AudioLines size={21} className="text-accent" aria-hidden />
          <h4 className="mt-3 text-sm font-semibold">{text.voice.title}</h4>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            {text.voice.body}
          </p>
          <a
            href={`${PLUGIN_DIRECTORY_URL}/tree/main/plugins/mimo-tts`}
            className="mt-4 inline-flex items-center gap-1 text-xs text-accent hover:underline underline-offset-4"
          >
            MiMo Narration
            <ArrowUpRight size={12} aria-hidden />
          </a>
        </article>
        <article>
          <Blocks size={21} className="text-accent" aria-hidden />
          <h4 className="mt-3 text-sm font-semibold">{text.more.title}</h4>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            {text.more.body}
          </p>
          <a
            href={`${DOCS_URL}${copy.meta.docsPath}builtin/index.html`}
            className="mt-4 inline-flex items-center gap-1 text-xs text-accent hover:underline underline-offset-4"
          >
            {text.more.link}
            <ArrowUpRight size={12} aria-hidden />
          </a>
        </article>
      </div>
      <p className="mt-6 text-xs leading-relaxed text-muted">{text.note}</p>
    </aside>
  );
}
