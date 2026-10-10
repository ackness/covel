import { lazy, memo, Suspense, useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ALLOWED_IMAGE_HOSTS_SETTING,
  allowHost,
  classifyImageSrc,
  ImageScopeContext,
  isHostAllowed,
  type AllowedImageHosts,
} from "@/lib/external-images.js";
import { useSetting } from "@/settings/use-settings.js";

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

/**
 * An image that is not on this app's own origin is held back: the browser
 * would request it at once and tell its host the player's address (and the
 * URL may carry text the model put there). The player loads it once, or
 * allows its host for this world.
 */
function ExternalImage({
  src,
  alt,
  host,
}: {
  src: string;
  alt?: string;
  host: string;
}) {
  const { t } = useTranslation();
  const worldId = useContext(ImageScopeContext);
  const [allowed, setAllowed] = useSetting<AllowedImageHosts>(
    ALLOWED_IMAGE_HOSTS_SETTING,
  );
  const [loaded, setLoaded] = useState(false);
  if (loaded || isHostAllowed(allowed, worldId, host)) {
    return <img src={src} alt={alt ?? ""} referrerPolicy="no-referrer" />;
  }
  return (
    <span className="not-prose my-1 inline-flex max-w-full flex-col gap-1 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
      <span>
        {t("session.externalImageHeld", { host })}
        {alt ? ` (${alt})` : ""}
      </span>
      <span className="flex flex-wrap gap-x-3 gap-y-1">
        <button
          type="button"
          className="underline underline-offset-2"
          onClick={() => setLoaded(true)}
        >
          {t("session.externalImageLoad")}
        </button>
        {worldId && (
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => void setAllowed(allowHost(allowed, worldId, host))}
          >
            {t("session.externalImageAlways", { host })}
          </button>
        )}
      </span>
    </span>
  );
}

function MarkdownImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const { t } = useTranslation();
  const url = typeof src === "string" ? src : undefined;
  const source = classifyImageSrc(url, window.location.origin);
  if (source.kind === "local" && url) return <img src={url} alt={alt ?? ""} />;
  if (source.kind === "external" && url) {
    return <ExternalImage src={url} alt={alt} host={source.host} />;
  }
  return <span className="text-xs">{t("session.externalImageBlocked")}</span>;
}

// Lazy-load react-markdown + the remark chain so the (sizeable) markdown
// parser stays out of the session first-paint path and only loads when the
// first rich-text message actually renders.
const LazyReactMarkdown = lazy(async () => {
  const [
    { default: ReactMarkdown, defaultUrlTransform },
    { default: remarkGfm },
  ] = await Promise.all([import("react-markdown"), import("remark-gfm")]);

  // The default transform drops every scheme but http(s), mailto and the like;
  // inline images and the media store's blob URLs are local and stay.
  const urlTransform = (url: string) =>
    /^(data:image\/|blob:)/i.test(url) ? url : defaultUrlTransform(url);

  function Inner({ children }: { children: string }) {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={urlTransform}
        components={{
          a: ({ href, children: linkChildren }) => (
            <a href={safeHref(href)} target="_blank" rel="noopener noreferrer">
              {linkChildren}
            </a>
          ),
          img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
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
