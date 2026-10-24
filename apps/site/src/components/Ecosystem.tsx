import { ArrowUpRight, GitBranch } from "lucide-react";
import type { Copy } from "../copy.js";
import {
  DOCS_URL,
  PLUGIN_DIRECTORY_URL,
  WORLD_DIRECTORY_URL,
} from "../links.js";

export function Ecosystem({ copy }: { copy: Copy }) {
  const text = copy.ecosystem;
  return (
    <aside
      className="mt-10 border-t border-line pt-8"
      aria-labelledby="ecosystem-title"
    >
      <h3 id="ecosystem-title" className="text-lg font-semibold">
        {text.title}
      </h3>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        {text.body}
      </p>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {[
          {
            href: PLUGIN_DIRECTORY_URL,
            name: "covel-ai/covel-plugins",
            description: text.plugins,
          },
          {
            href: WORLD_DIRECTORY_URL,
            name: "covel-ai/covel-worlds",
            description: text.worlds,
          },
        ].map((repo) => (
          <a
            key={repo.name}
            href={repo.href}
            className="flex items-center gap-3 rounded-xl border border-line px-4 py-3 transition hover:bg-raised"
          >
            <GitBranch className="size-5 shrink-0 text-muted" aria-hidden />
            <span className="min-w-0">
              <span className="block break-all font-mono text-xs">
                {repo.name}
              </span>
              <span className="mt-1 block text-xs text-muted">
                {repo.description}
              </span>
            </span>
            <ArrowUpRight
              className="ml-auto size-4 shrink-0 text-muted"
              aria-hidden
            />
          </a>
        ))}
      </div>
      <a
        href={`${DOCS_URL}${copy.meta.docsPath}start/packages.html`}
        className="mt-4 inline-flex items-center gap-1.5 text-xs text-muted underline-offset-4 hover:underline"
      >
        {text.guide}
        <ArrowUpRight size={12} aria-hidden />
      </a>
    </aside>
  );
}
