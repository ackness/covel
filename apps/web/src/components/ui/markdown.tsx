import { lazy, memo, Suspense } from "react";

/**
 * Restrict link targets to an explicit protocol allowlist. Anything else
 * (javascript:, data:, vbscript:, …) is dropped so rendered markdown can never
 * smuggle a script-bearing href into the DOM.
 */
const SAFE_LINK_PROTOCOLS = ["http:", "https:", "mailto:"];

function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href, window.location.origin);
    return SAFE_LINK_PROTOCOLS.includes(url.protocol) ? href : undefined;
  } catch {
    // Relative/anchor links without a parseable protocol are treated as safe.
    return href.startsWith("#") || href.startsWith("/") ? href : undefined;
  }
}

// Lazy-load react-markdown + the remark chain so the (sizeable) markdown
// parser stays out of the session first-paint path and only loads when the
// first rich-text message actually renders.
const LazyReactMarkdown = lazy(async () => {
  const [{ default: ReactMarkdown }, { default: remarkGfm }] =
    await Promise.all([import("react-markdown"), import("remark-gfm")]);

  function Inner({ children }: { children: string }) {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: linkChildren }) => (
            <a href={safeHref(href)} target="_blank" rel="noopener noreferrer">
              {linkChildren}
            </a>
          ),
          pre: ({ children: preChildren }) => (
            <pre className="overflow-x-auto">{preChildren}</pre>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    );
  }

  return { default: Inner };
});

function NonMemoizedMarkdown({ children }: { children: string }) {
  // While the parser chunk loads, fall back to the raw text so the message is
  // never blank — it simply upgrades to formatted markdown once ready.
  return (
    <Suspense
      fallback={<span className="whitespace-pre-wrap">{children}</span>}
    >
      <LazyReactMarkdown>{children}</LazyReactMarkdown>
    </Suspense>
  );
}

export const Markdown = memo(
  NonMemoizedMarkdown,
  (prev, next) => prev.children === next.children,
);
