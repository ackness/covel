/**
 * `<Media>` — generic frontend renderer for SPEC §5.1 (g) MediaRef payloads.
 *
 * Routes a `MediaRef` source into one of `<img>`, `<audio>`, `<video>`,
 * or a download `<a>` based on MIME.
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
import { useTranslation } from "react-i18next";
import { ImageOff } from "lucide-react";
import type { MediaRef } from "@covel/shared";
import { isMediaRef } from "../lib/media-ref-utils.js";
import { resolveMediaSrc } from "../lib/media-resolve.js";

export type MediaSrc = MediaRef;

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
  /**
   * When set (e.g. `"80vh"`), the image scales to its natural ratio bounded by
   * this height and the container width, instead of being forced to
   * `aspectRatio`. Used by the enlarge preview so a tall portrait fits the
   * viewport instead of overflowing it.
   */
  readonly maxHeight?: string;
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
      return "rounded-(--radius-card)";
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
    maxHeight,
    as = "auto",
  } = props;
  const { t } = useTranslation();

  const refForResolve = isMediaRef(src) ? src : null;
  const refMime = refForResolve?.mime ?? "";

  const [state, setState] = useState<ResolvedState>(INITIAL_STATE);

  // Track last revoke target so we don't revoke the URL for the next render.
  const revokeRef = useRef<string | null>(null);

  useEffect(() => {
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
        if (result.url.startsWith("blob:")) {
          URL.revokeObjectURL(result.url);
        }
        return;
      }
      revokeRef.current = result.url.startsWith("blob:") ? result.url : null;
      setState({
        url: result.url,
        fromCache: result.fromCache,
        status: result.ok ? "ready" : "error",
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
  }, [refForResolve?.id, refForResolve?.url, refForResolve?.mime, sessionId]);

  const kind: RenderKind = useMemo(
    () => pickRenderKind(refMime, as),
    [refMime, as],
  );

  const radius = radiusClass(rounded);
  // In maxHeight mode the placeholders keep the aspect ratio but never exceed
  // the bound, so a tall portrait's loading/error tile doesn't overflow either.
  const baseStyle = maxHeight ? { aspectRatio, maxHeight } : { aspectRatio };

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
        aria-label={alt || t("media.loading", "loading media")}
      />
    );
  }

  if (state.status === "error" || state.url.length === 0) {
    // Also the state of media the player deleted from the media library: say
    // that it is gone instead of showing its caption alone.
    const unavailable = t("media.unavailable", "media unavailable");
    return (
      <div
        className={clsx(
          "bg-muted border border-border flex flex-col items-center justify-center gap-1 w-full px-2 text-center",
          radius,
          className,
        )}
        style={baseStyle}
        role="img"
        aria-label={alt ? `${alt} (${unavailable})` : unavailable}
      >
        <ImageOff aria-hidden className="size-4 text-muted-foreground/70" />
        <span className="text-[10px] text-muted-foreground/70 font-mono">
          {unavailable}
        </span>
        {alt && (
          <span className="max-w-full truncate text-[10px] text-muted-foreground/70">
            {alt}
          </span>
        )}
      </div>
    );
  }

  if (kind === "image") {
    // Preview/enlarge mode: scale to the image's natural ratio, bounded by the
    // container width and `maxHeight`, centred — instead of forcing aspectRatio.
    if (maxHeight) {
      return (
        <img
          src={state.url}
          alt={alt}
          className={clsx(
            "block mx-auto max-w-full object-contain",
            radius,
            className,
          )}
          style={{ maxHeight }}
        />
      );
    }
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
        aria-label={alt || t("media.audio", "audio")}
        className={clsx("w-full block", className)}
      />
    );
  }

  if (kind === "video") {
    return (
      <video
        src={state.url}
        controls
        aria-label={alt || t("media.video", "video")}
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
      aria-label={alt || t("media.downloadFile", "download file")}
    >
      {alt || t("media.download", "Download")}
    </a>
  );
}
