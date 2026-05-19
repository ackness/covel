/**
 * `<AudioPlayer>` — theme-aware self-drawn audio player for plugin specs.
 *
 * Replaces native `<audio controls>` chrome (which never inherits app theme
 * tokens) with a flat playlist row: play/pause, scrub bar, time, speed,
 * download. All visuals use the catalog's theme tokens (`--color-primary`,
 * `--color-muted`, `--color-border`, `--radius-card`) so light + dark
 * surfaces both look intentional.
 *
 * Resolution semantics mirror `<Media>`:
 *   - Same `resolveMediaSrc(ref, { sessionId })` path → IDB cache → token URL.
 *   - Blob URL revoked on unmount and on src swap.
 *
 * Plugin specs reach the registered catalog wrapper, which extracts a
 * `MediaRef` from `props.ref` / `props.src` and forwards it here.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";
import { Download, Pause, Play } from "lucide-react";
import type { MediaRef } from "@covel/shared";
import { isMediaRef } from "../lib/media-ref-utils.js";
import { resolveMediaSrc } from "../lib/media-resolve.js";

export interface AudioPlayerProps {
  readonly src: MediaRef;
  /** Required so the underlying signed-token request scopes to this session. */
  readonly sessionId: string;
  readonly alt?: string;
  readonly className?: string;
  /** Filename used by the download button. Defaults to `<alt>.<ext>`. */
  readonly downloadName?: string;
}

const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 2] as const;

interface ResolvedState {
  readonly url: string;
  readonly status: "loading" | "ready" | "error";
}

const INITIAL: ResolvedState = { url: "", status: "loading" };

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function mimeToExt(mime: string): string {
  switch (mime) {
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
      return "wav";
    case "audio/ogg":
      return "ogg";
    case "audio/webm":
      return "webm";
    case "audio/L16":
    case "audio/pcm":
      return "pcm";
    default:
      return "audio";
  }
}

export function AudioPlayer(props: AudioPlayerProps): ReactElement {
  const { t } = useTranslation();
  const { src, sessionId, alt, className, downloadName } = props;
  const altText = alt ?? t("media.audio", "audio");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const revokeRef = useRef<string | null>(null);

  const [resolved, setResolved] = useState<ResolvedState>(INITIAL);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState<number>(1);

  const refValid = isMediaRef(src) ? src : null;

  // Resolve MediaRef → URL (mirrors Media.tsx for cache + cleanup parity).
  useEffect(() => {
    if (!refValid) {
      setResolved({ url: "", status: "error" });
      return;
    }
    const controller = new AbortController();
    setResolved(INITIAL);

    void resolveMediaSrc(refValid, {
      sessionId,
      signal: controller.signal,
    }).then((result) => {
      if (controller.signal.aborted) {
        if (result.url.startsWith("blob:")) URL.revokeObjectURL(result.url);
        return;
      }
      revokeRef.current = result.url.startsWith("blob:") ? result.url : null;
      setResolved({
        url: result.url,
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
  }, [refValid, sessionId]);

  // Subscribe to <audio> events whenever a fresh URL is mounted.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => setCurrentTime(a.currentTime);
    const onMeta = () =>
      setDuration(Number.isFinite(a.duration) ? a.duration : 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => setPlaying(false);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("durationchange", onMeta);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("ended", onEnded);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("durationchange", onMeta);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("ended", onEnded);
    };
  }, [resolved.url]);

  useEffect(() => {
    const a = audioRef.current;
    if (a) a.playbackRate = speed;
  }, [speed]);

  const togglePlay = (): void => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      const promise = a.play();
      if (promise && typeof promise.catch === "function") {
        promise.catch(() => {
          // Autoplay or media error — stay paused; user will retry.
        });
      }
    } else {
      a.pause();
    }
  };

  const scrubFromPointer = (
    ev: ReactPointerEvent<HTMLDivElement>,
    track: HTMLDivElement,
  ): void => {
    const a = audioRef.current;
    if (!a || duration <= 0) return;
    const rect = track.getBoundingClientRect();
    if (rect.width === 0) return;
    const ratio = Math.min(
      1,
      Math.max(0, (ev.clientX - rect.left) / rect.width),
    );
    a.currentTime = ratio * duration;
    setCurrentTime(a.currentTime);
  };

  const onTrackPointerDown = (ev: ReactPointerEvent<HTMLDivElement>): void => {
    const track = ev.currentTarget;
    track.setPointerCapture(ev.pointerId);
    scrubFromPointer(ev, track);
  };
  const onTrackPointerMove = (ev: ReactPointerEvent<HTMLDivElement>): void => {
    if ((ev.buttons & 1) === 0) return;
    scrubFromPointer(ev, ev.currentTarget);
  };
  const onTrackPointerUp = (ev: ReactPointerEvent<HTMLDivElement>): void => {
    if (ev.currentTarget.hasPointerCapture(ev.pointerId)) {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    }
  };
  const onTrackKeyDown = (ev: KeyboardEvent<HTMLDivElement>): void => {
    const a = audioRef.current;
    if (!a || duration <= 0) return;
    if (ev.key === "ArrowLeft") {
      a.currentTime = Math.max(0, a.currentTime - 5);
      ev.preventDefault();
    } else if (ev.key === "ArrowRight") {
      a.currentTime = Math.min(duration, a.currentTime + 5);
      ev.preventDefault();
    } else if (ev.key === " " || ev.key === "Enter") {
      togglePlay();
      ev.preventDefault();
    }
  };

  const progressPct = useMemo(() => {
    if (duration <= 0) return 0;
    return Math.min(100, Math.max(0, (currentTime / duration) * 100));
  }, [currentTime, duration]);

  if (!refValid || resolved.status === "error") {
    return (
      <div
        className={clsx(
          "flex items-center gap-2 px-3 py-2 border border-border rounded-[var(--radius-card)] bg-muted/40 w-full",
          className,
        )}
        role="status"
        aria-label={t("media.audioUnavailableAria", "{{label}} unavailable", {
          label: altText,
        })}
      >
        <span className="text-xs font-mono text-muted-foreground">
          {t("media.audioUnavailable", "audio unavailable")}
        </span>
      </div>
    );
  }

  const ext = mimeToExt(refValid.mime);
  const filename =
    downloadName ?? `${altText || t("media.audio", "audio")}.${ext}`;
  const isReady = resolved.status === "ready";

  return (
    <div
      className={clsx(
        "flex items-center gap-3 px-3 py-2 border border-border rounded-[var(--radius-card)] bg-muted/40 w-full",
        className,
      )}
      role="group"
      aria-label={altText}
    >
      <audio
        ref={audioRef}
        src={resolved.url}
        preload="metadata"
        aria-label={altText}
        className="hidden"
      />

      <button
        type="button"
        onClick={togglePlay}
        disabled={!isReady}
        className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 transition-opacity focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 focus:ring-offset-background"
        aria-label={
          playing ? t("media.pause", "Pause") : t("media.play", "Play")
        }
        aria-pressed={playing}
      >
        {playing ? (
          <Pause className="w-4 h-4" aria-hidden="true" />
        ) : (
          <Play className="w-4 h-4 translate-x-[1px]" aria-hidden="true" />
        )}
      </button>

      <span
        className="shrink-0 text-xs font-mono text-muted-foreground tabular-nums"
        data-testid="audio-time"
      >
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>

      <div
        ref={trackRef}
        role="slider"
        aria-label={t("media.seek", "Seek")}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, Math.floor(duration))}
        aria-valuenow={Math.floor(currentTime)}
        tabIndex={0}
        onPointerDown={onTrackPointerDown}
        onPointerMove={onTrackPointerMove}
        onPointerUp={onTrackPointerUp}
        onKeyDown={onTrackKeyDown}
        className="grow relative h-1.5 cursor-pointer rounded-full bg-border overflow-hidden touch-none select-none focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <div
          className="absolute inset-y-0 left-0 bg-primary transition-[width] duration-75 ease-linear"
          style={{ width: `${progressPct}%` }}
          data-testid="audio-progress-fill"
        />
      </div>

      <select
        value={speed}
        onChange={(ev) => setSpeed(Number(ev.target.value))}
        className="shrink-0 text-xs font-mono bg-transparent text-muted-foreground hover:text-foreground border-0 cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring rounded-sm py-0.5"
        aria-label={t("media.playbackSpeed", "Playback speed")}
      >
        {SPEED_OPTIONS.map((value) => (
          <option key={value} value={value}>
            {value}×
          </option>
        ))}
      </select>

      <a
        href={isReady ? resolved.url : undefined}
        download={filename}
        className={clsx(
          "shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-border/40 transition-colors focus:outline-none focus:ring-2 focus:ring-ring",
          !isReady && "pointer-events-none opacity-40",
        )}
        aria-label={t("media.downloadAudio", "Download audio")}
        title={filename}
      >
        <Download className="w-3.5 h-3.5" aria-hidden="true" />
      </a>
    </div>
  );
}
