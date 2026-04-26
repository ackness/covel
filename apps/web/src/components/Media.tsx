/**
 * `<Media>` — generic frontend renderer for SPEC §5.1 (g) MediaRef payloads.
 *
 * Routes a `MediaRef | string` source into one of `<img>`, `<audio>`,
 * `<video>`, or a download `<a>` based on MIME.  String `src` is treated
 * as a literal URL for backward compatibility with existing plugin specs
 * that pre-date the MediaRef migration.
 *
 * - Resolves through `resolveMediaSrc` (IDB cache → ref.url → token endpoint
 *   → 1x1 PNG sentinel).
 * - Revokes blob URLs on unmount.
 * - Renders a stable aspect-ratio placeholder while loading so layout
 *   doesn't shift (CWV / SPEC §5.7 acceptance).
 *
 * The component intentionally does **not** read any global session
 * context: `sessionId` is a required prop so plugin specs that mount
 * the component outside the main session shell still work (debug pages,
 * snapshots, etc.).
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { clsx } from "clsx";
import {
  isMediaRef,
  type MediaRef,
} from "../_stubs/media-types.js";
import { resolveMediaSrc } from "../lib/media-resolve.js";

export type MediaSrc = MediaRef | string;

export interface MediaProps {
  readonly src: MediaSrc;
  /** Required to scope server-side signed-token requests to the current session. */
  readonly sessionId: string;
  readonly alt?: string;
  /** CSS aspect-ratio string, e.g. "1/1", "16/9". Default `"1/1"`. */
  readonly aspectRatio?: string;
  readonly rounded?: "none" | "sm" | "md" | "lg";
  readonly fit?: "cover" | "contain";
  readonly className?: string;
  /** Override mime sniff (rare; e.g. force <audio> for octet-stream). */
  readonly as?: "image" | "audio" | "video" | "auto";
}

type RenderKind = "image" | "audio" | "video" | "file";

function pickRenderKind(mime: string, override?: MediaProps["as"]): RenderKind {
  if (override && override !== "auto") return override;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

function radiusClass(rounded: NonNullable<MediaProps["rounded"]>): string {
  switch (rounded) {
    case "none":
      return "rounded-none";
    case "sm":
      return "rounded-sm";
    case "lg":
      return "rounded-lg";
    case "md":
    default:
      return "rounded-[var(--radius-card)]";
  }
}

interface ResolvedState {
  readonly url: string;
  readonly fromCache: boolean;
  readonly status: "loading" | "ready" | "error";
}

const INITIAL_STATE: ResolvedState = {
  url: "",
  fromCache: false,
  status: "loading",
};

export function Media(props: MediaProps): ReactElement {
  const {
    src,
    sessionId,
    alt = "",
    aspectRatio = "1/1",
    rounded = "md",
    fit = "cover",
    className,
    as = "auto",
  } = props;

  // Normalise input. `string` src skips resolution entirely (backward
  // compat with the legacy <Image> spec).
  const isRef = typeof src !== "string" && isMediaRef(src);
  const refMime = isRef ? (src as MediaRef).mime : "";
  const refForResolve = isRef ? (src as MediaRef) : null;

  const [state, setState] = useState<ResolvedState>(() => {
    if (typeof src === "string") {
      return { url: src, fromCache: true, status: "ready" };
    }
    return INITIAL_STATE;
  });

  // Track last revoke target so we don't revoke the URL for the next render.
  const revokeRef = useRef<string | null>(null);

  useEffect(() => {
    // String src: nothing to fetch.
    if (typeof src === "string") {
      setState({ url: src, fromCache: true, status: "ready" });
      return;
    }

    if (!refForResolve) {
      setState({ url: "", fromCache: false, status: "error" });
      return;
    }

    const controller = new AbortController();
    setState(INITIAL_STATE);

    void resolveMediaSrc(refForResolve, {
      sessionId,
      signal: controller.signal,
    }).then((result) => {
      if (controller.signal.aborted) {
        // We're about to be re-resolved; release the URL we just made.
        if (!result.fromCache && result.url.startsWith("blob:")) {
          URL.revokeObjectURL(result.url);
        }
        return;
      }
      revokeRef.current = result.fromCache ? null : result.url;
      setState({
        url: result.url,
        fromCache: result.fromCache,
        status: "ready",
      });
    });

    return () => {
      controller.abort();
      const toRevoke = revokeRef.current;
      revokeRef.current = null;
      if (toRevoke && toRevoke.startsWith("blob:")) {
        URL.revokeObjectURL(toRevoke);
      }
    };
    // sessionId rarely changes, but it does affect token scoping.
  }, [refForResolve, sessionId, src]);

  const kind: RenderKind = useMemo(
    () => pickRenderKind(refMime || guessMimeFromUrl(state.url), as),
    [refMime, state.url, as],
  );

  const radius = radiusClass(rounded);
  const baseStyle = { aspectRatio } as const;

  if (state.status === "loading") {
    return (
      <div
        className={clsx(
          "bg-muted border border-border flex items-center justify-center w-full",
          radius,
          className,
        )}
        style={baseStyle}
        role="img"
        aria-busy="true"
        aria-label={alt || "loading media"}
      />
    );
  }

  if (state.status === "error" || state.url.length === 0) {
    return (
      <div
        className={clsx(
          "bg-muted border border-border flex items-center justify-center w-full",
          radius,
          className,
        )}
        style={baseStyle}
        role="img"
        aria-label={alt || "media unavailable"}
      >
        <span className="text-[10px] text-muted-foreground/70 font-mono">
          {alt || "media unavailable"}
        </span>
      </div>
    );
  }

  if (kind === "image") {
    return (
      <img
        src={state.url}
        alt={alt}
        loading="lazy"
        className={clsx(
          "w-full block",
          radius,
          fit === "contain" ? "object-contain" : "object-cover",
          className,
        )}
        style={baseStyle}
      />
    );
  }

  if (kind === "audio") {
    return (
      <audio
        src={state.url}
        controls
        aria-label={alt || "audio"}
        className={clsx("w-full block", className)}
      />
    );
  }

  if (kind === "video") {
    return (
      <video
        src={state.url}
        controls
        aria-label={alt || "video"}
        className={clsx("w-full block", radius, className)}
        style={baseStyle}
      />
    );
  }

  // file: surface a download link rather than embed unknown content.
  return (
    <a
      href={state.url}
      download
      className={clsx(
        "inline-flex items-center px-3 py-2 text-sm border border-border rounded-md bg-card hover:bg-muted",
        className,
      )}
      aria-label={alt || "download file"}
    >
      {alt || "Download"}
    </a>
  );
}

/**
 * Best-effort mime sniff from a URL when we only have a string source.
 * Used for the legacy string-src path so the component still routes to
 * the right element (<audio>/<video>) when the plugin spec passes a CDN
 * URL with a useful extension.
 */
function guessMimeFromUrl(url: string): string {
  if (!url) return "";
  const lower = url.toLowerCase().split("?")[0];
  if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/.test(lower)) return "image/*";
  if (/\.(mp3|wav|ogg|m4a|flac)$/.test(lower)) return "audio/*";
  if (/\.(mp4|webm|mov|m4v)$/.test(lower)) return "video/*";
  if (lower.startsWith("data:")) {
    const semi = url.indexOf(";");
    if (semi > 5) return url.slice(5, semi);
  }
  return "";
}
