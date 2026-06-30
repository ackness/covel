import { useState } from "react";
import type { ComponentRenderer } from "@json-render/react";
import { clsx } from "clsx";
import { Media as MediaComponent } from "@/components/Media.js";
import { MediaPreviewDialog } from "@/components/MediaPreviewDialog.js";
import { AudioPlayer as AudioPlayerComponent } from "@/components/AudioPlayer.js";
import {
  ImageGalleryPanel,
  ImageJobsPanel,
} from "@/components/session/image-plugin-panels.js";
import type { MediaRef } from "@covel/shared";
import { isMediaRef } from "@/lib/media-ref-utils.js";
import { useActiveSessionId } from "./session-context.js";

/**
 * Image — renders an image asset through MediaRef resolution.
 *
 * Props:
 *   ref:      MediaRef object returned by an asset.generate proposal.
 *   src:      MediaRef object accepted for early plugin specs.
 *   alt:      accessibility fallback.
 *   aspectRatio: "1/1" | "16/9" | "3/4" | string — CSS aspect-ratio.
 *   rounded:  "none" | "sm" | "md" | "lg" — border-radius scale.
 *   fit:      "cover" | "contain" — object-fit behaviour (default "cover").
 *
 * When no MediaRef is bound, renders a muted placeholder so the layout stays
 * stable and no broken-image glyph appears.
 */
/**
 * Pick the appropriate radius utility class for Image and Media placeholders.
 */
function imageRadiusCls(rounded: string): string {
  if (rounded === "none") return "rounded-none";
  if (rounded === "sm") return "rounded-sm";
  if (rounded === "lg") return "rounded-lg";
  return "rounded-[var(--radius-card)]";
}

/**
 * Read either `props.src` or `props.ref` for a MediaRef. Plugin specs
 * use `ref` for new code (matches the SPEC); some early adopters set
 * `src` to a MediaRef object directly. Both shapes route through the
 * same `<Media>` component.
 */
function extractMediaRef(
  props: Record<string, unknown> | undefined,
): MediaRef | null {
  if (!props) return null;
  const candidates: unknown[] = [props.ref, props.src];
  for (const c of candidates) {
    if (isMediaRef(c)) return c;
  }
  return null;
}

export const ImageComponent: ComponentRenderer = ({ element }) => {
  const sessionId = useActiveSessionId();
  const [zoomed, setZoomed] = useState(false);
  const props = element.props ?? {};
  const alt = (props.alt as string | undefined) ?? "";
  const aspectRatio = (props.aspectRatio as string | undefined) ?? "1/1";
  const rounded = (props.rounded as string | undefined) ?? "md";
  const fit = (props.fit as "cover" | "contain" | undefined) ?? "cover";

  const ref = extractMediaRef(props);
  if (ref) {
    const overrideSession =
      typeof props.sessionId === "string" && props.sessionId.length > 0
        ? (props.sessionId as string)
        : sessionId;
    const media = (
      <MediaComponent
        src={ref}
        sessionId={overrideSession}
        alt={alt}
        aspectRatio={aspectRatio}
        rounded={rounded as "none" | "sm" | "md" | "lg"}
        fit={fit}
        as="image"
      />
    );
    // `zoom: true` makes the image click-to-enlarge via the shared preview.
    if (props.zoom !== true) return media;
    return (
      <>
        <button
          type="button"
          onClick={() => setZoomed(true)}
          className="block w-full cursor-zoom-in"
          aria-label={alt || "enlarge image"}
        >
          {media}
        </button>
        <MediaPreviewDialog
          mediaRef={zoomed ? ref : null}
          sessionId={overrideSession}
          title={alt || undefined}
          aspectRatio={aspectRatio}
          onClose={() => setZoomed(false)}
        />
      </>
    );
  }

  const radiusCls = imageRadiusCls(rounded);
  return (
    <div
      className={clsx(
        "bg-muted border border-border flex items-center justify-center",
        radiusCls,
      )}
      style={{ aspectRatio }}
      aria-label={alt || "image placeholder"}
    >
      <span className="text-[10px] text-muted-foreground/70 font-mono">
        no image
      </span>
    </div>
  );
};

/**
 * `Media` registry entry — generic renderer for SPEC §5.1 (g). Plugin
 * specs can use `{ "type": "Media", "props": { "ref": <MediaRef>, ... } }`
 * to render any modality (image / audio / video). Falls through to a
 * `<a download>` link for unknown MIME types so unfamiliar payloads
 * never break the layout.
 */
export const MediaCatalogComponent: ComponentRenderer = ({ element }) => {
  const sessionId = useActiveSessionId();
  const props = element.props ?? {};
  const ref = extractMediaRef(props);

  const overrideSession =
    typeof props.sessionId === "string" && props.sessionId.length > 0
      ? (props.sessionId as string)
      : sessionId;

  const alt = (props.alt as string | undefined) ?? "";
  const aspectRatio = (props.aspectRatio as string | undefined) ?? "1/1";
  const rounded =
    (props.rounded as "none" | "sm" | "md" | "lg" | undefined) ?? "md";
  const fit = (props.fit as "cover" | "contain" | undefined) ?? "cover";
  const as =
    (props.as as "image" | "audio" | "video" | "auto" | undefined) ?? "auto";

  if (!ref) {
    return (
      <div
        className={clsx(
          "bg-muted border border-border flex items-center justify-center",
          imageRadiusCls(rounded),
        )}
        style={{ aspectRatio }}
        aria-label={alt || "media placeholder"}
      >
        <span className="text-[10px] text-muted-foreground/70 font-mono">
          no media
        </span>
      </div>
    );
  }

  return (
    <MediaComponent
      src={ref}
      sessionId={overrideSession}
      alt={alt}
      aspectRatio={aspectRatio}
      rounded={rounded}
      fit={fit}
      as={as}
    />
  );
};

/**
 * `AudioPlayer` registry entry — theme-aware self-drawn audio player for
 * plugin specs. Replaces native `<audio controls>` chrome (which never
 * inherits theme tokens) with a flat playlist row. Plugin specs use:
 *   `{ "component": "AudioPlayer", "props": { "ref": <MediaRef>, "alt": "…" } }`
 *
 * Falls back to a compact "audio unavailable" tile when the bound MediaRef
 * is missing — so a row in the audio Tab whose `ref` hasn't been written
 * yet renders harmlessly instead of an oversized empty block.
 */
export const AudioPlayerCatalogComponent: ComponentRenderer = ({ element }) => {
  const sessionId = useActiveSessionId();
  const props = element.props ?? {};
  const ref = extractMediaRef(props);
  const alt = (props.alt as string | undefined) ?? "";
  const downloadName = (props.downloadName as string | undefined) ?? undefined;
  const className = (props.className as string | undefined) ?? undefined;

  const overrideSession =
    typeof props.sessionId === "string" && props.sessionId.length > 0
      ? (props.sessionId as string)
      : sessionId;

  if (!ref) {
    return (
      <div
        className="flex items-center gap-2 px-3 py-2 border border-border rounded-[var(--radius-card)] bg-muted/40 w-full"
        role="status"
        aria-label={alt ? `${alt} unavailable` : "audio unavailable"}
      >
        <span className="text-xs font-mono text-muted-foreground">
          audio unavailable
        </span>
      </div>
    );
  }

  return (
    <AudioPlayerComponent
      src={ref}
      sessionId={overrideSession}
      alt={alt}
      downloadName={downloadName}
      className={className}
    />
  );
};

/** Source — subtle source attribution label. */
export const ImageGallery: ComponentRenderer = ({ element }) => {
  const pluginId = element.props?.pluginId as string | undefined;
  return pluginId ? <ImageGalleryPanel pluginId={pluginId} /> : null;
};

export const ImageJobs: ComponentRenderer = ({ element }) => {
  const pluginId = element.props?.pluginId as string | undefined;
  return pluginId ? <ImageJobsPanel pluginId={pluginId} /> : null;
};

export const Source: ComponentRenderer = ({ element }) => {
  const label = (element.props?.label as string) ?? "";
  return (
    <span className="text-[9px] text-muted-foreground/70 block mt-1 font-mono tracking-[0.04em]">
      {label}
    </span>
  );
};
