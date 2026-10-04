import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { ChevronLeft, ChevronRight, Images, Pause, Play } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import {
  listWorldGallery,
  type WorldGalleryItem,
  type WorldRecord,
} from "@/services/api.js";
import { useInView } from "@/hooks/use-in-view.js";
import { worldVisualForId } from "@/lib/world-visuals.js";

/**
 * The art a world package ships — scenes and character portraits — shown on
 * the world list and the world details, before any session exists.
 */

const NO_IMAGES: readonly WorldGalleryItem[] = [];
const galleryRequests = new Map<string, Promise<WorldGalleryItem[]>>();

/** The images of one world; empty while loading and for a world without art. */
export function useWorldGallery(
  world: WorldRecord | null | undefined,
): readonly WorldGalleryItem[] {
  const worldId = world?.id;
  // A changed package is a changed record, so its images are read again.
  const key = world ? `${world.id}\u0000${world.updatedAt ?? ""}` : "";
  const [loaded, setLoaded] = useState<{
    key: string;
    items: readonly WorldGalleryItem[];
  }>({ key: "", items: NO_IMAGES });

  useEffect(() => {
    if (!worldId) return;
    let cancelled = false;
    let pending = galleryRequests.get(key);
    if (!pending) {
      pending = listWorldGallery(worldId).catch(() => {
        // Not kept: the next visit asks again.
        galleryRequests.delete(key);
        return [];
      });
      galleryRequests.set(key, pending);
    }
    void pending.then((items) => {
      if (!cancelled) setLoaded({ key, items });
    });
    return () => {
      cancelled = true;
    };
  }, [worldId, key]);

  return loaded.key === key ? loaded.items : NO_IMAGES;
}

/**
 * Wide images are scenes and can fill the screen; the rest are figures —
 * character portraits and sprites — and only ever show as pictures.
 */
export function splitGallery(items: readonly WorldGalleryItem[]): {
  backdrops: WorldGalleryItem[];
  figures: WorldGalleryItem[];
} {
  const isBackdrop = (item: WorldGalleryItem) =>
    item.width >= item.height * 1.2;
  return {
    backdrops: items.filter(isBackdrop),
    figures: items.filter((item) => !isBackdrop(item)),
  };
}

const SLIDE_INTERVAL_MS = 7000;
/** A cover under the pointer changes sooner: the player is waiting for it. */
const CARD_SLIDE_INTERVAL_MS = 2600;

export interface Slideshow {
  readonly index: number;
  readonly playing: boolean;
  /** Show one slide; a choice by hand stops the rotation. */
  readonly show: (index: number) => void;
  readonly toggle: () => void;
}

/**
 * A rotation through `count` slides that starts over when `resetKey` changes.
 * It does not start by itself for a player who asked for reduced motion.
 */
export function useSlideshow(
  resetKey: string,
  count: number,
  intervalMs = SLIDE_INTERVAL_MS,
): Slideshow {
  // Read once: a rotation does not start or stop because the setting changed.
  const [reducedMotion] = useState(
    () =>
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  const [position, setPosition] = useState({ key: resetKey, index: 0 });
  const [chosen, setChosen] = useState<boolean | null>(null);
  const playing = chosen ?? !reducedMotion;
  const index =
    position.key === resetKey && position.index < count ? position.index : 0;

  useEffect(() => {
    if (!playing || count < 2) return;
    const timer = window.setInterval(() => {
      // A hidden tab keeps its slide; nobody is watching the next one load.
      if (document.hidden) return;
      setPosition((current) => ({
        key: resetKey,
        index: ((current.key === resetKey ? current.index : 0) + 1) % count,
      }));
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [playing, count, resetKey, intervalMs]);

  return {
    index,
    playing,
    show: (next) => {
      setChosen(false);
      setPosition({ key: resetKey, index: ((next % count) + count) % count });
    },
    toggle: () => setChosen(!playing),
  };
}

/**
 * Full-bleed slides that fade into one another. The slide before stays
 * underneath until the next one has faded in, so the change never shows the
 * page behind.
 */
export function ShowcaseBackdrop({
  slides,
  index,
  loading,
}: {
  readonly slides: readonly string[];
  readonly index: number;
  /** `lazy` for a cover that may sit far down a list. */
  readonly loading?: "eager" | "lazy";
}) {
  const current = slides[index] ?? slides[0]!;
  const [settled, setSettled] = useState(current);
  const upcoming = slides[(index + 1) % slides.length];

  // Fetched while the current slide shows, so the fade starts on a loaded image.
  useEffect(() => {
    if (!upcoming || upcoming === current) return;
    const image = new Image();
    image.src = upcoming;
  }, [upcoming, current]);

  return (
    <>
      {settled !== current && (
        <img
          key={settled}
          src={settled}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover"
          draggable={false}
        />
      )}
      <img
        key={current}
        src={current}
        alt=""
        aria-hidden="true"
        width={1536}
        height={1024}
        loading={loading}
        className="ui-stage-crossfade absolute inset-0 h-full w-full object-cover"
        draggable={false}
        onAnimationEnd={() => setSettled(current)}
      />
    </>
  );
}

/** Position and controls of the backdrop rotation. */
export function SlideIndicator({
  count,
  slideshow,
  t,
}: {
  readonly count: number;
  readonly slideshow: Slideshow;
  readonly t: TFunction;
}) {
  if (count < 2) return null;
  return (
    <div className="ui-world-glass flex h-9 items-center gap-1 rounded-(--radius-control) border px-1.5">
      <button
        type="button"
        onClick={slideshow.toggle}
        aria-label={t(
          slideshow.playing ? "world.slidesPause" : "world.slidesPlay",
        )}
        title={t(slideshow.playing ? "world.slidesPause" : "world.slidesPlay")}
        className="flex size-7 items-center justify-center rounded-(--radius-control) hover:bg-white/15"
      >
        {slideshow.playing ? (
          <Pause className="h-3.5 w-3.5" />
        ) : (
          <Play className="h-3.5 w-3.5" />
        )}
      </button>
      {/* Past a dozen slides the dots are too small to aim at. */}
      {count <= 12 ? (
        <div className="flex items-center">
          {Array.from({ length: count }, (_, slide) => (
            <button
              key={slide}
              type="button"
              onClick={() => slideshow.show(slide)}
              aria-label={t("world.slideShow", { index: slide + 1 })}
              aria-current={slide === slideshow.index}
              className="group flex h-7 w-4 items-center justify-center"
            >
              <span
                className={`block h-1.5 rounded-full transition-all ${
                  slide === slideshow.index
                    ? "w-3 bg-(--accent-primary)"
                    : "w-1.5 bg-white/45 group-hover:bg-white/80"
                }`}
              />
            </button>
          ))}
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => slideshow.show(slideshow.index - 1)}
            aria-label={t("world.galleryPrevious")}
            className="flex size-7 items-center justify-center rounded-(--radius-control) hover:bg-white/15"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="px-0.5 text-xs tabular-nums text-white/85">
            {slideshow.index + 1} / {count}
          </span>
          <button
            type="button"
            onClick={() => slideshow.show(slideshow.index + 1)}
            aria-label={t("world.galleryNext")}
            className="flex size-7 items-center justify-center rounded-(--radius-control) hover:bg-white/15"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  );
}

/** One picture of the gallery, cropped to a thumbnail that opens it. */
function GalleryThumb({
  item,
  position,
  total,
  className,
  onOpen,
  t,
}: {
  readonly item: WorldGalleryItem;
  readonly position: number;
  readonly total: number;
  readonly className: string;
  readonly onOpen: () => void;
  readonly t: TFunction;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("world.galleryOpen", {
        index: position + 1,
        total,
      })}
      className={`shrink-0 cursor-zoom-in overflow-hidden rounded-(--radius-control) ${className}`}
      style={{
        aspectRatio: item.width >= item.height * 1.2 ? "3 / 2" : "3 / 4",
      }}
    >
      <img
        src={item.url}
        alt=""
        loading="lazy"
        decoding="async"
        // A portrait is cut at the knees, not at the face.
        className="h-full w-full object-cover object-top"
        draggable={false}
      />
    </button>
  );
}

/** A row of the first pictures of a world; the last tile opens the rest. */
export function WorldGalleryStrip({
  items,
  limit,
  surface = false,
  onOpen,
  t,
}: {
  readonly items: readonly WorldGalleryItem[];
  readonly limit: number;
  /** On a plain surface in the theme's colours, not over a darkened image. */
  readonly surface?: boolean;
  readonly onOpen: (index: number) => void;
  readonly t: TFunction;
}) {
  if (items.length === 0) return null;
  const shown = items.slice(0, limit);
  const hidden = items.length - shown.length;
  return (
    <div
      role="group"
      aria-label={t("world.gallery")}
      className="flex items-center gap-2"
    >
      {shown.map((item, index) => (
        <GalleryThumb
          key={item.id}
          item={item}
          position={index}
          total={items.length}
          className={`border transition-colors ${
            surface
              ? "h-16 border-border bg-secondary hover:border-(--rule-strong-color)"
              : "h-20 border-white/22 bg-white/8 hover:border-white/60"
          }`}
          onOpen={() => onOpen(index)}
          t={t}
        />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => onOpen(shown.length)}
          aria-label={t("world.galleryAll", { total: items.length })}
          title={t("world.galleryAll", { total: items.length })}
          className={`flex shrink-0 items-center justify-center rounded-(--radius-control) border text-sm tabular-nums ${
            surface
              ? "h-16 w-12 border-border bg-secondary text-muted-foreground hover:text-foreground"
              : "ui-world-glass h-20 w-14"
          }`}
        >
          +{hidden}
        </button>
      )}
    </div>
  );
}

/** One picture at full size, with the others a key press away. */
export function WorldGalleryLightbox({
  items,
  index,
  title,
  onIndexChange,
  t,
}: {
  readonly items: readonly WorldGalleryItem[];
  /** The picture shown; null keeps the lightbox closed. */
  readonly index: number | null;
  readonly title: string;
  readonly onIndexChange: (index: number | null) => void;
  readonly t: TFunction;
}) {
  const item = index === null ? undefined : items[index];
  const step = (delta: number) => {
    if (index === null) return;
    onIndexChange((index + delta + items.length) % items.length);
  };
  return (
    <Dialog
      open={Boolean(item)}
      onOpenChange={(open) => {
        if (!open) onIndexChange(null);
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="flex w-auto max-w-[96vw] flex-col items-center gap-0 border-white/15 bg-black p-0 text-white"
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") step(-1);
          if (event.key === "ArrowRight") step(1);
        }}
      >
        <DialogTitle className="sr-only">
          {title} — {t("world.gallery")}
        </DialogTitle>
        {item && (
          <img
            key={item.id}
            src={item.url}
            alt=""
            width={item.width}
            height={item.height}
            className="max-h-[84vh] w-auto max-w-[96vw] object-contain"
            draggable={false}
          />
        )}
        {items.length > 1 && index !== null && (
          <div className="flex w-full items-center justify-center gap-3 py-2">
            <button
              type="button"
              onClick={() => step(-1)}
              aria-label={t("world.galleryPrevious")}
              className="flex size-9 items-center justify-center rounded-(--radius-control) hover:bg-white/15"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm tabular-nums text-white/85">
              {index + 1} / {items.length}
            </span>
            <button
              type="button"
              onClick={() => step(1)}
              aria-label={t("world.galleryNext")}
              className="flex size-9 items-center justify-center rounded-(--radius-control) hover:bg-white/15"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * A world's art split for display: the slides behind a title, and every
 * picture. A world without a cover of its own opens on its own scenes.
 */
export function useWorldArt(
  world: WorldRecord | null | undefined,
  cover: string,
): {
  slides: string[];
  figures: WorldGalleryItem[];
  pictures: WorldGalleryItem[];
} {
  const gallery = useWorldGallery(world);
  const ownCover = worldVisualForId(world?.id) !== null;
  return useMemo(() => {
    const { backdrops, figures } = splitGallery(gallery);
    const scenes = backdrops.map((item) => item.url);
    return {
      slides: scenes.length > 0 && !ownCover ? scenes : [cover, ...scenes],
      figures,
      // Portraits lead: a face says more in a thumbnail than a landscape.
      pictures: [...figures, ...backdrops],
    };
  }, [gallery, cover, ownCover]);
}

/**
 * The cover of a world card. The world's scenes pass over it while the pointer
 * rests there, and a few faces at its foot open the gallery. The art is read
 * once the card is near the screen, so a long list asks only for what shows.
 */
export function WorldCardCover({
  world,
  title,
  cover,
  eager,
  className,
  children,
  t,
}: {
  readonly world: WorldRecord;
  /** The world's name as shown, for the gallery's own title. */
  readonly title: string;
  readonly cover: string;
  /** Among the first covers of the list, which load at once. */
  readonly eager: boolean;
  readonly className: string;
  readonly children?: ReactNode;
  readonly t: TFunction;
}) {
  const [ref, inView] = useInView<HTMLDivElement>({ rootMargin: "200px" });
  const { slides, figures, pictures } = useWorldArt(
    inView ? world : null,
    cover,
  );
  const [resting, setResting] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const slideshow = useSlideshow(
    world.id,
    resting ? slides.length : 1,
    CARD_SLIDE_INTERVAL_MS,
  );
  return (
    <div
      ref={ref}
      className={`relative overflow-hidden ${className}`}
      onPointerEnter={() => setResting(true)}
      onPointerLeave={() => setResting(false)}
    >
      <ShowcaseBackdrop
        slides={slides}
        index={slideshow.index}
        loading={eager ? "eager" : "lazy"}
      />
      {children}
      {pictures.length > 0 && (
        <button
          type="button"
          onClick={() => setOpen(0)}
          aria-label={t("world.galleryAll", { total: pictures.length })}
          title={t("world.galleryAll", { total: pictures.length })}
          className="absolute bottom-2.5 left-3 flex cursor-zoom-in items-center"
        >
          {figures.slice(0, 3).map((item) => (
            <img
              key={item.id}
              src={item.url}
              alt=""
              loading="lazy"
              decoding="async"
              className="-ml-2 size-9 rounded-full border-2 border-white/85 bg-black/40 object-cover object-top first:ml-0"
              draggable={false}
            />
          ))}
          <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-xs tabular-nums text-white backdrop-blur-sm">
            <Images className="h-3 w-3" aria-hidden />
            {pictures.length}
          </span>
        </button>
      )}
      <WorldGalleryLightbox
        items={pictures}
        index={open}
        title={title}
        onIndexChange={setOpen}
        t={t}
      />
    </div>
  );
}

/** Every picture of a world as a grid, for the world details. */
export function WorldGallerySection({
  world,
  title,
  t,
}: {
  readonly world: WorldRecord;
  readonly title: string;
  readonly t: TFunction;
}) {
  const items = useWorldGallery(world);
  const [open, setOpen] = useState<number | null>(null);
  if (items.length === 0) return null;
  return (
    <section aria-label={t("world.gallery")} className="space-y-3">
      <h2 className="ui-title text-lg">{t("world.gallery")}</h2>
      <div className="flex flex-wrap gap-2.5">
        {items.map((item, index) => (
          <GalleryThumb
            key={item.id}
            item={item}
            position={index}
            total={items.length}
            className="h-36 border border-border bg-card transition-colors hover:border-(--rule-strong-color)"
            onOpen={() => setOpen(index)}
            t={t}
          />
        ))}
      </div>
      <WorldGalleryLightbox
        items={items}
        index={open}
        title={title}
        onIndexChange={setOpen}
        t={t}
      />
    </section>
  );
}
